import { Capability } from '@cloudpunch/shared';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { DbRepositories } from '../db/index.js';
import { requireCapability } from '../auth/require.js';
import { enrollDeviceService } from './enroll.js';
import { enrollDeviceBodySchema, type EnrollDeviceResponse } from './schemas.js';

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
};

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
