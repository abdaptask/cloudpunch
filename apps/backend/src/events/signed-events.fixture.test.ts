import {
  canonicalizeSignedFields,
  importEd25519PublicKey,
  verifyEventSignature,
} from '@cloudpunch/event-schema';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InMemoryDb } from '../db/in-memory.js';
import { ingestBatch } from './ingest.js';
import { ingestBatchBodySchema } from './schemas.js';

/**
 * Shared signed-event fixture. The desktop encoder (`event/encode.rs`)
 * produces these exact bytes from a fixed test key; here the same
 * events go through the real batch schema, signature check, and
 * ingest. If either side changes the wire format, one of the two
 * tests fails. See ADR-0004 §5–§6 and ADR-0014.
 */
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../packages/event-schema/fixtures/signed-events.json', import.meta.url),
    'utf8',
  ),
) as {
  public_key_base64: string;
  envelope: {
    device_id: string;
    session_id: string;
    employee_id: string;
    correlation_id: string;
  };
  events: unknown[];
};

const publicKeyRaw = new Uint8Array(Buffer.from(fixture.public_key_base64, 'base64'));
const body = ingestBatchBodySchema.parse({ ...fixture.envelope, events: fixture.events });

describe('signed events from the desktop encoder', () => {
  it('parse as one ingest batch', () => {
    expect(body.events.length).toBeGreaterThan(1);
    expect(body.events[0]?.event_type).toBe('USER_CLOCK_IN');
  });

  it('every signature verifies against the device key', async () => {
    const publicKey = await importEd25519PublicKey(publicKeyRaw);
    for (const evt of body.events) {
      const signedBytes = canonicalizeSignedFields({
        ...evt,
        correlation_id: body.correlation_id,
        device_id: body.device_id,
        employee_id: body.employee_id,
        session_id: body.session_id,
      });
      const ok = await verifyEventSignature({
        publicKey,
        signatureBase64: evt.integrity_signature,
        signedBytes,
      });
      expect(ok, evt.event_type).toBe(true);
    }
  });

  it('are all accepted by ingest and close the session', async () => {
    const db = new InMemoryDb();
    const userOid = '11111111-2222-4333-8444-555555555555';
    const userId = '22222222-3333-4444-8555-666666666666';
    db.seedEmployee({
      id: body.employee_id,
      source: 'local_admin',
      greythrEmployeeId: null,
      employeeNumber: null,
      givenName: 'Golden',
      familyName: 'Fixture',
      displayName: null,
      workEmail: 'golden@aptask.com',
      status: 'active',
    });
    db.seedUser(
      {
        id: userId,
        entraObjectId: userOid,
        workEmail: 'golden@aptask.com',
        displayName: 'Golden Fixture',
        isServiceAccount: false,
        breakGlass: false,
        employeeId: body.employee_id,
      },
      userOid,
    );
    await db.devices.enroll({
      id: body.device_id,
      userId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: publicKeyRaw,
      appVersion: '0.0.0',
    });

    const r = await ingestBatch({
      db,
      authOid: userOid,
      deviceId: body.device_id,
      sessionId: body.session_id,
      employeeId: body.employee_id,
      correlationId: body.correlation_id,
      events: body.events,
    });

    expect(r.status).toBe('batch_accepted');
    if (r.status === 'batch_accepted') {
      expect(r.results.map((x) => x.status)).toEqual(body.events.map(() => 'accepted'));
      expect(r.sessionClosedWith).not.toBeNull();
    }
  });
});
