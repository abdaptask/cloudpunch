/**
 * CLI: `node --import tsx scripts/notify.ts "<subject>" [text]`
 *
 * Email the owner (ADR-0035). The text comes from the second argument,
 * or from stdin when it's absent. Used by the backup and health jobs on
 * the server (infra/pilot). Reads the API's settings (api.env: tenant,
 * client id, certificate, WELCOME_FROM) and ALERT_TO (comma-separated)
 * from the environment. Exits 1 if the email can't be sent.
 */
import { readFileSync } from 'node:fs';
import { addressList } from '../src/people/welcome.js';
import { graphTokenForApp } from '../src/people/obo.js';
import { sendAlert } from '../src/ops/alert.js';

const env = process.env;
const [subject, arg] = process.argv.slice(2);
const missing = [
  'ENTRA_TENANT_ID',
  'ENTRA_API_CLIENT_ID',
  'ENTRA_OBO_CERT_KEY_PATH',
  'ENTRA_OBO_CERT_THUMBPRINT',
  'WELCOME_FROM',
  'ALERT_TO',
].filter((k) => !env[k]);
if (!subject || missing.length > 0) {
  process.stderr.write(
    `notify: usage: notify.ts "<subject>" [text]; missing: ${missing.join(', ') || 'subject'}\n`,
  );
  process.exit(1);
}

const text = arg ?? readFileSync(0, 'utf8');
try {
  const token = await graphTokenForApp({
    tenantId: env['ENTRA_TENANT_ID'] ?? '',
    clientId: env['ENTRA_API_CLIENT_ID'] ?? '',
    privateKeyPem: readFileSync(env['ENTRA_OBO_CERT_KEY_PATH'] ?? '', 'utf8'),
    thumbprint: env['ENTRA_OBO_CERT_THUMBPRINT'] ?? '',
  });
  await sendAlert(token, {
    from: env['WELCOME_FROM'] ?? '',
    to: addressList(env['ALERT_TO']),
    subject,
    text: text.slice(0, 20_000),
  });
  process.stdout.write(`notify: sent "${subject}"\n`);
} catch (e) {
  process.stderr.write(`notify: not sent: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
