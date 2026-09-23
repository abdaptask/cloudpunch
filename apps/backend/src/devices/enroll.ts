import type { DbRepositories, Device, DeviceOs } from '../db/index.js';

export interface EnrollDeviceServiceInput {
  db: DbRepositories;
  authOid: string;
  deviceId: string;
  os: DeviceOs;
  hostnameHash: string;
  publicKeyEd25519: Uint8Array;
  appVersion: string;
}

export type EnrollDeviceServiceResult =
  | { ok: true; device: Device }
  | {
      ok: false;
      code: 'no_user_for_oid' | 'wrong_public_key_length' | 'device_owner_conflict';
      message: string;
    };

/**
 * Enrol a device for the currently authenticated user, or re-enrol an
 * existing one owned by the same user with a refreshed public key.
 *
 * Idempotent semantics per ADR-0004 §5:
 *   - Same device_id + same user → refresh public key, preserve
 *     enrolled_at, keep revocation status.
 *   - Same device_id + different user → 409 device_owner_conflict.
 *   - New device_id → create.
 */
export async function enrollDeviceService(
  input: EnrollDeviceServiceInput,
): Promise<EnrollDeviceServiceResult> {
  if (input.publicKeyEd25519.length !== 32) {
    return {
      ok: false,
      code: 'wrong_public_key_length',
      message: `expected 32-byte Ed25519 public key, got ${input.publicKeyEd25519.length}`,
    };
  }

  const user = await input.db.users.findByEntraObjectId(input.authOid);
  if (!user) {
    return {
      ok: false,
      code: 'no_user_for_oid',
      message: 'authenticated Entra oid has no CloudPunch user',
    };
  }

  try {
    const device = await input.db.devices.enroll({
      id: input.deviceId,
      userId: user.id,
      os: input.os,
      hostnameHash: input.hostnameHash,
      publicKeyEd25519: input.publicKeyEd25519,
      appVersion: input.appVersion,
    });
    return { ok: true, device };
  } catch (err) {
    if (err instanceof Error && /different user/.test(err.message)) {
      return {
        ok: false,
        code: 'device_owner_conflict',
        message: 'device is already enrolled by a different user',
      };
    }
    throw err;
  }
}
