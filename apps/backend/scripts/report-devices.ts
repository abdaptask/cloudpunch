/**
 * CLI entrypoint: `pnpm report:devices`
 *
 * Who signs in from where, straight from the database: devices per user
 * and every device with its OS, app version, enrolment and last-seen
 * times. The same data as `GET /v1/admin/devices`, for use before the
 * web dashboard exists.
 *
 * Read-only. Reads POSTGRES_APP_URL (the app role) from the environment;
 * never prints the connection string.
 */
import { createPostgresClient, PostgresDb } from '../src/db/postgres/index.js';
import { toDeviceList } from '../src/devices/routes.js';

const url = process.env['POSTGRES_APP_URL'];
if (!url) {
  process.stderr.write('report-devices: POSTGRES_APP_URL env var required\n');
  process.exit(1);
}

const sql = createPostgresClient(url, { max: 1 });
const when = (iso: string | null): string => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');

try {
  const { users, devices } = toDeviceList(await new PostgresDb(sql).devices.listWithOwners());
  process.stdout.write(`${users.length} user(s), ${devices.length} device(s)\n\n`);
  console.table(
    users.map((u) => ({
      user: u.work_email,
      name: u.display_name,
      active: u.active_devices,
      total: u.total_devices,
      'last seen (UTC)': when(u.last_seen_at),
    })),
  );
  console.table(
    devices.map((d) => ({
      user: d.work_email,
      device: d.device_id.slice(0, 8),
      os: d.os,
      app: d.app_version,
      host: d.hostname_hash.slice(7, 19),
      'enrolled (UTC)': when(d.enrolled_at),
      'last seen (UTC)': when(d.last_seen_at),
      revoked: d.revoked_at ? `${when(d.revoked_at)} ${d.revoked_reason ?? ''}` : '',
    })),
  );
} catch (err) {
  process.stderr.write(
    `report-devices: failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
