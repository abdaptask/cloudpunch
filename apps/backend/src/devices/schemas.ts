import { z } from 'zod';

/**
 * Ed25519 raw public keys are always 32 bytes; base64-encoded that's
 * either 44 chars (padded) or 43 chars (unpadded url-safe). Accept
 * both variants and validate the decoded length in the handler.
 */
const BASE64_ED25519_PUBKEY = z
  .string()
  .min(43)
  .max(44)
  .regex(/^[A-Za-z0-9+/_=-]+$/, 'must be base64 (standard or url-safe)');

/**
 * SHA-256 as lowercase hex, prefixed with `sha256-` so we never
 * confuse the hash algorithm on log lines.
 */
const HOSTNAME_HASH = z.string().regex(/^sha256-[0-9a-f]{64}$/, 'must be sha256-<64 hex chars>');

const SEMVER = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'must be semver');

export const enrollDeviceBodySchema = z
  .object({
    device_id: z.string().uuid(),
    os: z.enum(['windows', 'macos']),
    hostname_hash: HOSTNAME_HASH,
    public_key_ed25519: BASE64_ED25519_PUBKEY,
    app_version: SEMVER,
  })
  .strict();

export type EnrollDeviceBody = z.infer<typeof enrollDeviceBodySchema>;

export const enrollDeviceResponseSchema = z
  .object({
    device_id: z.string().uuid(),
    enrolled_at: z.string().datetime(),
    revoked: z.boolean(),
  })
  .strict();

export type EnrollDeviceResponse = z.infer<typeof enrollDeviceResponseSchema>;

/**
 * `GET /v1/admin/devices`: who signs in from where. The public key is
 * left out (not needed to answer the question); the hostname stays a
 * hash (ADR-0004 §5).
 */
export interface AdminDeviceListResponse {
  devices: {
    device_id: string;
    user_id: string;
    work_email: string;
    display_name: string;
    os: 'windows' | 'macos';
    hostname_hash: string;
    app_version: string;
    enrolled_at: string;
    last_seen_at: string | null;
    revoked_at: string | null;
    revoked_reason: string | null;
  }[];
  /** One row per user who has enrolled at least one device. */
  users: {
    user_id: string;
    work_email: string;
    display_name: string;
    /** Not revoked. */
    active_devices: number;
    total_devices: number;
    last_seen_at: string | null;
  }[];
}
