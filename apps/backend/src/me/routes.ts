import { capabilitiesForRoles } from '@cloudpunch/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import type { DbRepositories } from '../db/index.js';
import { requireAuth } from '../auth/require.js';
import { activeDeviceOf } from '../devices/active.js';

export interface MeRoutesOptions {
  db: DbRepositories;
}

/**
 * GET /v1/me — returns the caller's user, employee (if any), roles,
 * and effective capabilities. The desktop calls this once after
 * sign-in so it knows the correct employee_id to include in signed
 * event bodies (ADR-0004 §5).
 */
const meRoutesImpl: FastifyPluginAsync<MeRoutesOptions> = async (app, opts) => {
  activeDeviceRoute(app, opts);
  app.get('/v1/me', { preHandler: [requireAuth] }, async (req, reply) => {
    // requireAuth guarantees req.auth is defined; narrow explicitly so
    // strict TS is happy without a non-null assertion.
    const claims = req.auth;
    if (!claims) {
      return reply
        .code(500)
        .type('application/problem+json')
        .send({ code: 'internal', message: 'auth preHandler did not populate req.auth' });
    }
    const user = await opts.db.users.findByEntraObjectId(claims.oid);
    if (!user) {
      return reply.code(403).type('application/problem+json').send({
        code: 'no_user_for_oid',
        message: 'authenticated Entra oid has no CloudPunch user record',
      });
    }

    const employee = user.employeeId ? await opts.db.employees.findById(user.employeeId) : null;

    // Block clock-in for non-active employees at this boundary too so
    // the desktop knows immediately (also enforced at ingest per ADR-0005).
    const clockAllowed = employee?.status === 'active';

    const capabilities = Array.from(capabilitiesForRoles(claims.roles)).sort();

    return reply.code(200).send({
      user: {
        id: user.id,
        entra_object_id: user.entraObjectId,
        work_email: user.workEmail,
        display_name: user.displayName,
        is_service_account: user.isServiceAccount,
        break_glass: user.breakGlass,
      },
      employee: employee
        ? {
            id: employee.id,
            source: employee.source,
            greythr_employee_id: employee.greythrEmployeeId,
            employee_number: employee.employeeNumber,
            display_name: employee.displayName ?? `${employee.givenName} ${employee.familyName}`,
            work_email: employee.workEmail,
            status: employee.status,
          }
        : null,
      roles: [...claims.roles].sort(),
      capabilities,
      clock_allowed: clockAllowed,
    });
  });
};

const activeDeviceQuery = z.object({ device_id: z.string().uuid() });

/**
 * GET /v1/me/active-device?device_id= — one machine at a time
 * (ADR-0028 §2). The app calls it after sign-in and enrolment:
 *   - `this_device.signed_out`: an Administrator signed this machine
 *     out (§4); the app should sign out.
 *   - `elsewhere`: the caller's open session on another machine, or
 *     null. While set, the app shows the blocked screen.
 * The caller's own data only: `device_id` must be one of their devices.
 */
function activeDeviceRoute(app: FastifyInstance, opts: MeRoutesOptions): void {
  app.get('/v1/me/active-device', { preHandler: [requireAuth] }, async (req, reply) => {
    const claims = req.auth;
    if (!claims) {
      return reply
        .code(500)
        .type('application/problem+json')
        .send({ code: 'internal', message: 'auth preHandler did not populate req.auth' });
    }
    const q = activeDeviceQuery.safeParse(req.query);
    if (!q.success) {
      return reply
        .code(400)
        .type('application/problem+json')
        .send({ code: 'validation', message: 'device_id must be a UUID' });
    }
    const user = await opts.db.users.findByEntraObjectId(claims.oid);
    if (!user) {
      return reply.code(403).type('application/problem+json').send({
        code: 'no_user_for_oid',
        message: 'authenticated Entra oid has no CloudPunch user record',
      });
    }
    const device = await opts.db.devices.findById(q.data.device_id);
    if (!device || device.userId !== user.id) {
      return reply
        .code(404)
        .type('application/problem+json')
        .send({ code: 'unknown_device', message: 'no such device for this user' });
    }
    const active = user.employeeId ? await activeDeviceOf(opts.db, user.employeeId) : null;
    const elsewhere =
      active && active.deviceId !== device.id
        ? {
            device_id: active.deviceId,
            os: active.os,
            enrolled_at: active.enrolledAt.toISOString(),
            opened_at: active.openedAt.toISOString(),
          }
        : null;
    return reply.code(200).send({
      this_device: { signed_out: Boolean(device.signoutRequestedAt) },
      elsewhere,
    });
  });
}

export const meRoutes = fp(meRoutesImpl, {
  name: 'cloudpunch-me',
  fastify: '4.x',
});

export default meRoutes;
