import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryDb } from '../db/in-memory.js';
import { enrollDeviceService } from './enroll.js';

let db: InMemoryDb;
let userOid: string;
let userId: string;
let employeeId: string;

beforeEach(() => {
  db = new InMemoryDb();
  userOid = randomUUID();
  userId = randomUUID();
  employeeId = randomUUID();
  db.seedEmployee({
    id: employeeId,
    source: 'local_admin',
    greythrEmployeeId: null,
    employeeNumber: null,
    givenName: 'Alice',
    familyName: 'Test',
    displayName: null,
    workEmail: 'alice@aptask.com',
    status: 'active',
  });
  db.seedUser(
    {
      id: userId,
      entraObjectId: userOid,
      workEmail: 'alice@aptask.com',
      displayName: 'Alice Test',
      isServiceAccount: false,
      breakGlass: false,
      employeeId,
    },
    userOid,
  );
});

describe('enrollDeviceService', () => {
  const goodPk = new Uint8Array(32).fill(0x11);

  it('creates a new device on first enrollment', async () => {
    const r = await enrollDeviceService({
      db,
      authOid: userOid,
      deviceId: randomUUID(),
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: goodPk,
      appVersion: '0.1.0',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.device.userId).toBe(userId);
      expect(r.device.revokedAt).toBeNull();
    }
  });

  it('rejects a non-32-byte public key', async () => {
    const r = await enrollDeviceService({
      db,
      authOid: userOid,
      deviceId: randomUUID(),
      os: 'macos',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: new Uint8Array(16),
      appVersion: '0.1.0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('wrong_public_key_length');
  });

  it('rejects when oid has no CloudPunch user', async () => {
    const r = await enrollDeviceService({
      db,
      authOid: 'unknown-oid',
      deviceId: randomUUID(),
      os: 'macos',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: goodPk,
      appVersion: '0.1.0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_user_for_oid');
  });

  it('refreshes the public key on re-enrollment by same user', async () => {
    const deviceId = randomUUID();
    const first = await enrollDeviceService({
      db,
      authOid: userOid,
      deviceId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: goodPk,
      appVersion: '0.1.0',
    });
    const newPk = new Uint8Array(32).fill(0x22);
    const second = await enrollDeviceService({
      db,
      authOid: userOid,
      deviceId,
      os: 'windows',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: newPk,
      appVersion: '0.1.1',
    });
    expect(second.ok).toBe(true);
    if (second.ok && first.ok) {
      expect(second.device.enrolledAt).toEqual(first.device.enrolledAt);
      expect(second.device.publicKeyEd25519).toEqual(newPk);
      expect(second.device.appVersion).toBe('0.1.1');
    }
  });

  it('conflicts on re-enrollment by a different user', async () => {
    const deviceId = randomUUID();
    await enrollDeviceService({
      db,
      authOid: userOid,
      deviceId,
      os: 'macos',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: goodPk,
      appVersion: '0.1.0',
    });
    const otherOid = randomUUID();
    db.seedUser(
      {
        id: randomUUID(),
        entraObjectId: otherOid,
        workEmail: 'bob@aptask.com',
        displayName: 'Bob',
        isServiceAccount: false,
        breakGlass: false,
        employeeId: null,
      },
      otherOid,
    );
    const r = await enrollDeviceService({
      db,
      authOid: otherOid,
      deviceId,
      os: 'macos',
      hostnameHash: 'sha256-' + '0'.repeat(64),
      publicKeyEd25519: goodPk,
      appVersion: '0.1.0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('device_owner_conflict');
  });
});
