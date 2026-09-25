/**
 * CLI entrypoint: `pnpm seed:dev -- --oid <uuid> --email <x@aptask.com> --given <name> --family <name>`
 *
 * Creates one active `local_admin` employee and links the Entra user
 * (`app_user`) to it, so that user can call /v1/me, enrol a device, and
 * clock in against the dev database. Idempotent: an `app_user` that is
 * already linked to an employee is left alone.
 *
 * Dev only. Reads POSTGRES_URL (the migrator role) from the environment
 * and refuses to run unless CLOUDPUNCH_ENV is `dev` (or unset).
 * Never prints the connection string.
 */
import postgres from 'postgres';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  process.stderr.write(`seed-dev-user: ${message}\n`);
  process.exit(1);
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value || value.startsWith('--')) fail(`--${name} is required`);
  return value.trim();
}

const env = process.env['CLOUDPUNCH_ENV'] ?? 'dev';
if (env !== 'dev') fail(`refusing to seed CLOUDPUNCH_ENV=${env}`);
const url = process.env['POSTGRES_URL'];
if (!url) fail('POSTGRES_URL env var required');

const oid = arg('oid').toLowerCase();
const email = arg('email');
const given = arg('given');
const family = arg('family');
if (!UUID.test(oid)) fail('--oid must be the Entra object id (a UUID)');
if (!/^[^@\s]+@aptask\.com$/i.test(email)) fail('--email must be an @aptask.com address');

const sql = postgres(url, { onnotice: () => undefined });

try {
  const result = await sql.begin(async (tx) => {
    const existing = await tx<{ id: string; employeeId: string | null }[]>`
      SELECT id, employee_id AS "employeeId" FROM app_user
      WHERE entra_object_id = ${oid} FOR UPDATE
    `;
    const current = existing[0];
    if (current?.employeeId) {
      return { userId: current.id, employeeId: current.employeeId, created: false };
    }

    const [employee] = await tx<{ id: string }[]>`
      INSERT INTO employee (source, given_name, family_name, display_name, status)
      VALUES ('local_admin', ${given}, ${family}, ${`${given} ${family}`}, 'active')
      RETURNING id
    `;
    if (!employee) throw new Error('employee insert returned no row');

    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app_user (entra_object_id, work_email, display_name, employee_id)
      VALUES (${oid}, ${email}, ${`${given} ${family}`}, ${employee.id})
      ON CONFLICT (entra_object_id)
        DO UPDATE SET employee_id = EXCLUDED.employee_id, updated_at = now()
      RETURNING id
    `;
    if (!user) throw new Error('app_user upsert returned no row');
    return { userId: user.id, employeeId: employee.id, created: true };
  });

  process.stdout.write(
    `seed-dev-user: ${result.created ? 'created' : 'already linked'} ` +
      `app_user=${result.userId} employee=${result.employeeId}\n`,
  );
} catch (err) {
  fail(`failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await sql.end();
}
