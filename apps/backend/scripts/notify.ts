/**
 * CLI: `node --import tsx scripts/notify.ts "<subject>" [text]`
 *
 * Tell the owner (ADR-0035, ADR-0043): an email to ALERT_TO
 * (comma-separated) with CloudPunch's own Graph credentials, and a post
 * to the Teams channel at TEAMS_ALERT_WEBHOOK_URL. Neither needs the API
 * to be running. Either one is enough: it exits 1 only when nothing got
 * through. Used by the backup and health jobs on the server
 * (infra/pilot). The text comes from the second argument, or from stdin
 * when it's absent. Reads the API's settings (api.env: tenant, client
 * id, certificate, WELCOME_FROM) and alert.env from the environment.
 */
import { readFileSync } from 'node:fs';
import { addressList } from '../src/people/welcome.js';
import { graphTokenForApp } from '../src/people/obo.js';
import { sendAlert } from '../src/ops/alert.js';
import { postTeams } from '../src/ops/teams.js';

const env = process.env;
const [subject, arg] = process.argv.slice(2);
const MAIL = [
  'ENTRA_TENANT_ID',
  'ENTRA_API_CLIENT_ID',
  'ENTRA_OBO_CERT_KEY_PATH',
  'ENTRA_OBO_CERT_THUMBPRINT',
  'WELCOME_FROM',
  'ALERT_TO',
];
const mailMissing = MAIL.filter((k) => !env[k]);
const webhook = env['TEAMS_ALERT_WEBHOOK_URL'];
if (!subject || (mailMissing.length > 0 && !webhook)) {
  process.stderr.write(
    `notify: usage: notify.ts "<subject>" [text]; set ALERT_TO (and the mail settings) or TEAMS_ALERT_WEBHOOK_URL; missing: ${mailMissing.join(', ') || 'subject'}\n`,
  );
  process.exit(1);
}

const text = (arg ?? readFileSync(0, 'utf8')).slice(0, 20_000);
let sent = 0;

if (mailMissing.length === 0) {
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
      text,
    });
    sent++;
    process.stdout.write(`notify: emailed "${subject}"\n`);
  } catch (e) {
    process.stderr.write(`notify: email not sent: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

if (webhook) {
  try {
    await postTeams(webhook, {
      title: subject,
      // Teams shows a short card: the first paragraphs, not a log dump.
      lines: text
        .split('\n\n')
        .slice(0, 4)
        .map((p) => p.slice(0, 1500)),
      attention: !subject.startsWith('Fixed'),
    });
    sent++;
    process.stdout.write(`notify: posted "${subject}" to Teams\n`);
  } catch (e) {
    process.stderr.write(
      `notify: Teams post failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

process.exit(sent > 0 ? 0 : 1);
