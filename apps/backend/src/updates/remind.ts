import { randomUUID } from 'node:crypto';
import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import type { ShiftMail } from '../alerts/mail.js';
import { requireCapability } from '../auth/require.js';
import type { DbRepositories, DeviceWithOwner } from '../db/index.js';
import { readReleases, type Platform } from '../landing/routes.js';
import { isNewer } from './routes.js';

/**
 * Computers → Email to update (ADR-0046, owner request 2026-10-15):
 *
 *   POST /v1/admin/updates/remind {user_ids, message?}
 *
 * Emails each chosen person, on their own, that their computer is
 * behind the latest published CloudPunch and how to update. Addresses
 * and versions come from the server's records, never the request. At
 * most one reminder per person an hour; every one is in audit_log.
 * Same capability as "Push the update" (a company setting).
 */

export interface UpdateRemindOptions {
  db: DbRepositories;
  /** CloudPunch's mailbox; without it the request is refused (503). */
  send?: ((m: ShiftMail) => Promise<void>) | null;
  downloadsDir?: string | undefined;
  siteUrl: string;
  now?: () => Date;
}

export const REMIND_EVERY_MS = 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const body = z
  .object({
    user_ids: z.array(z.string().regex(UUID)).min(1).max(500),
    message: z.string().trim().max(1000).optional(),
  })
  .strict();

export type SkipReason =
  'not_found' | 'no_computer' | 'up_to_date' | 'no_email' | 'reminded_recently' | 'send_failed';

function problem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type('application/problem+json').send({ code, message });
}

const osName = (os: string): string => (os === 'macos' ? 'Mac' : 'Windows PC');

/** The email for one person whose computers in `behind` need `latest`. */
export function reminderMail(input: {
  to: string;
  name: string;
  behind: readonly { os: string; version: string; latest: string }[];
  message: string | undefined;
  siteUrl: string;
}): ShiftMail {
  const first = input.name.trim().split(/\s+/)[0] || input.name;
  const latest = input.behind.map((b) => b.latest).sort((a, b) => (isNewer(a, b) ? -1 : 1))[0];
  const lines = input.behind.map(
    (b) => `Your ${osName(b.os)} has CloudPunch ${b.version}; the latest is ${b.latest}.`,
  );
  const site = input.siteUrl.replace(/\/+$/, '');
  const text = [
    `Hi ${first},`,
    ...(input.message ? [input.message] : []),
    lines.join('\n'),
    [
      'To update:',
      "- Leave CloudPunch open: it updates by itself once you've been clocked out for 2 minutes.",
      '- Or now: open CloudPunch, open your account menu and choose Check for updates, then Restart to update.',
      `- Or download it and install it again: ${site}/app/download/`,
    ].join('\n'),
    'Thank you,\nCloudPunch',
  ].join('\n\n');
  return {
    to: [input.to],
    cc: [],
    subject: `Please update CloudPunch to ${latest ?? 'the latest version'}`,
    text,
  };
}

const remindImpl: FastifyPluginAsync<UpdateRemindOptions> = async (app, opts) => {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());

  app.post(
    '/v1/admin/updates/remind',
    { preHandler: [requireCapability([Capability.AdminPolicyWrite])] },
    async (req, reply) => {
      const parsed = body.safeParse(req.body);
      if (!parsed.success) {
        return problem(reply, 400, 'invalid_body', parsed.error.issues[0]?.message ?? 'invalid');
      }
      const send = opts.send;
      if (!send) {
        return problem(reply, 503, 'mail_not_configured', "CloudPunch's mailbox isn't set up");
      }
      const actor = req.auth ? await db.users.findByEntraObjectId(req.auth.oid) : null;
      if (!actor) return problem(reply, 403, 'forbidden', 'no CloudPunch account');

      const latestOf = async (p: Platform): Promise<string | null> =>
        (await readReleases(opts.downloadsDir, p)).find((r) => !!r.signature)?.version ?? null;
      const latest: Record<string, string | null> = {
        windows: await latestOf('windows'),
        macos: await latestOf('macos'),
      };
      const byUser = new Map<string, DeviceWithOwner[]>();
      for (const d of await db.devices.listWithOwners()) {
        if (d.revokedAt !== null) continue;
        byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), d]);
      }

      const sent: string[] = [];
      const skipped: { id: string; reason: SkipReason }[] = [];
      for (const id of [...new Set(parsed.data.user_ids)]) {
        const user = await db.users.findById(id);
        if (!user) {
          skipped.push({ id, reason: 'not_found' });
          continue;
        }
        const devices = byUser.get(id) ?? [];
        if (devices.length === 0) {
          skipped.push({ id, reason: 'no_computer' });
          continue;
        }
        const behind = devices.flatMap((d) => {
          const l = latest[d.os];
          return l && isNewer(l, d.appVersion)
            ? [{ os: d.os, version: d.appVersion, latest: l }]
            : [];
        });
        if (behind.length === 0) {
          skipped.push({ id, reason: 'up_to_date' });
          continue;
        }
        if (!user.workEmail.includes('@')) {
          skipped.push({ id, reason: 'no_email' });
          continue;
        }
        const last = await db.devices.lastUpdateReminderAt(id);
        const at = now();
        if (last && at.getTime() - last.getTime() < REMIND_EVERY_MS) {
          skipped.push({ id, reason: 'reminded_recently' });
          continue;
        }
        const mail = reminderMail({
          to: user.workEmail,
          name: user.displayName,
          behind,
          message: parsed.data.message || undefined,
          siteUrl: opts.siteUrl,
        });
        try {
          await send(mail);
        } catch (err) {
          req.log.warn({ err, userId: id }, 'update reminder not sent');
          skipped.push({ id, reason: 'send_failed' });
          continue;
        }
        await db.devices.auditUpdateReminder({
          actorUserId: actor.id,
          userId: id,
          to: user.workEmail,
          versions: behind.map((b) => b.version),
          latest: behind[0]?.latest ?? '',
          correlationId: randomUUID(),
          at,
        });
        sent.push(id);
      }
      return reply.code(200).send({ sent: sent.length, sent_ids: sent, skipped });
    },
  );
};

export const updateRemindRoutes = fp(remindImpl, { name: 'update-remind-routes' });
