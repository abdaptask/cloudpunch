import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { DbRepositories, DeviceWithOwner } from '../db/index.js';
import { requireCapability } from '../auth/require.js';
import { enrollDeviceService } from './enroll.js';
import {
  enrollDeviceBodySchema,
  type AdminDeviceListResponse,
  type EnrollDeviceResponse,
} from './schemas.js';

export interface DeviceRoutesOptions {
  db: DbRepositories;
}

const devicesRoutesImpl: FastifyPluginAsync<DeviceRoutesOptions> = async (app, opts) => {
  app.post(
    '/v1/devices/enroll',
    { preHandler: [requireCapability(Capability.SelfDeviceWrite)] },
    async (req, reply) => {
      const parsed = enrollDeviceBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).type('application/problem+json').send({
          code: 'validation',
          message: 'invalid enrollment body',
          issues: parsed.error.issues,
        });
      }

      const publicKeyBytes = decodeBase64OrUrlSafe(parsed.data.public_key_ed25519);
      if (!publicKeyBytes) {
        return reply.code(400).type('application/problem+json').send({
          code: 'validation',
          message: 'public_key_ed25519 is not valid base64',
        });
      }

      // requireCapability guarantees req.auth is defined; narrow explicitly.
      const auth = req.auth;
      if (!auth) {
        return reply
          .code(500)
          .type('application/problem+json')
          .send({ code: 'internal', message: 'auth preHandler did not populate req.auth' });
      }

      const result = await enrollDeviceService({
        db: opts.db,
        authOid: auth.oid,
        deviceId: parsed.data.device_id,
        os: parsed.data.os,
        hostnameHash: parsed.data.hostname_hash,
        publicKeyEd25519: publicKeyBytes,
        appVersion: parsed.data.app_version,
      });

      if (!result.ok) {
        if (result.code === 'device_owner_conflict') {
          return reply.code(409).type('application/problem+json').send({
            code: result.code,
            message: result.message,
          });
        }
        if (result.code === 'no_user_for_oid') {
          return reply.code(403).type('application/problem+json').send({
            code: result.code,
            message: result.message,
          });
        }
        return reply.code(400).type('application/problem+json').send({
          code: result.code,
          message: result.message,
        });
      }

      const body: EnrollDeviceResponse = {
        device_id: result.device.id,
        enrolled_at: result.device.enrolledAt.toISOString(),
        revoked: result.device.revokedAt !== null,
      };
      return reply.code(200).send(body);
    },
  );

  // Who signs in from where: every enrolled device and a per-user
  // count. Administrators manage devices; Auditors read everything.
  app.get(
    '/v1/admin/devices',
    { preHandler: [requireCapability([Capability.AdminDeviceRead])] },
    async (_req, reply) => {
      const devices = await opts.db.devices.listWithOwners();
      return reply.code(200).send(toDeviceList(devices));
    },
  );
};

/** Pure: shape the device list and per-user summary. */
export function toDeviceList(devices: readonly DeviceWithOwner[]): AdminDeviceListResponse {
  const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
  const users = new Map<string, AdminDeviceListResponse['users'][number]>();
  for (const d of devices) {
    const u = users.get(d.userId) ?? {
      user_id: d.userId,
      work_email: d.ownerWorkEmail,
      display_name: d.ownerDisplayName,
      active_devices: 0,
      total_devices: 0,
      last_seen_at: null,
    };
    u.total_devices += 1;
    if (d.revokedAt === null) u.active_devices += 1;
    const seen = iso(d.lastSeenAt);
    if (seen && (!u.last_seen_at || seen > u.last_seen_at)) u.last_seen_at = seen;
    users.set(d.userId, u);
  }
  return {
    devices: devices.map((d) => ({
      device_id: d.id,
      user_id: d.userId,
      work_email: d.ownerWorkEmail,
      display_name: d.ownerDisplayName,
      os: d.os,
      hostname_hash: d.hostnameHash,
      app_version: d.appVersion,
      enrolled_at: d.enrolledAt.toISOString(),
      last_seen_at: iso(d.lastSeenAt),
      revoked_at: iso(d.revokedAt),
      revoked_reason: d.revokedReason,
    })),
    users: [...users.values()].sort((a, b) => a.work_email.localeCompare(b.work_email)),
  };
}

function decodeBase64OrUrlSafe(input: string): Uint8Array | null {
  const normal = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normal.length % 4 === 0 ? normal : normal + '='.repeat(4 - (normal.length % 4));
  try {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  } catch {
    return null;
  }
}

export const devicesRoutes = fp(devicesRoutesImpl, {
  name: 'cloudpunch-devices',
  fastify: '4.x',
});

export default devicesRoutes;
