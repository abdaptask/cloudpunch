import { webcrypto } from 'node:crypto';

/**
 * Ed25519 signature helpers used by the backend to verify event
 * signatures produced by an enrolled desktop agent. The desktop uses
 * the equivalent Rust primitives; both must accept the same inputs and
 * produce the same verify result.
 *
 * Node's WebCrypto Ed25519 support is stable on Node 20+ (algorithm
 * name `'Ed25519'`, no separate hash parameter).
 */

const ED25519_SIG_BYTES = 64;
const ED25519_PUBKEY_BYTES = 32;

/**
 * Import a raw 32-byte Ed25519 public key into a WebCrypto CryptoKey
 * usable with {@link verifyEd25519}.
 */
export async function importEd25519PublicKey(rawKey: Uint8Array): Promise<webcrypto.CryptoKey> {
  if (rawKey.length !== ED25519_PUBKEY_BYTES) {
    throw new SignatureError(
      `expected ${ED25519_PUBKEY_BYTES}-byte Ed25519 public key, got ${rawKey.length}`,
    );
  }
  return webcrypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'Ed25519' },
    false, // not extractable
    ['verify'],
  );
}

/**
 * Verify an Ed25519 signature over `data` using an imported public key.
 * Returns `true` iff the signature is valid. Returns `false` (never
 * throws) for malformed or tampered inputs — cryptographic failure is
 * a normal outcome and callers respond with a `signature_invalid`
 * result code rather than a 500.
 *
 * Throws only for programmer errors: wrong-length signature or a key
 * that was not imported for `verify`.
 */
export async function verifyEd25519(
  publicKey: webcrypto.CryptoKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  if (signature.length !== ED25519_SIG_BYTES) {
    throw new SignatureError(
      `expected ${ED25519_SIG_BYTES}-byte Ed25519 signature, got ${signature.length}`,
    );
  }
  try {
    return await webcrypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, data);
  } catch (err) {
    // WebCrypto rejects malformed signatures with an error rather than
    // returning false. Normalize to "invalid signature".
    if (err instanceof Error && /Ed25519/i.test(err.message)) {
      return false;
    }
    throw err;
  }
}

/**
 * Convenience: verify an event's `integrity_signature` (base64) against
 * a device's raw public key over the canonical signed-subset bytes.
 * Callers usually construct `signedBytes` via
 * `canonicalizeSignedFields(event)`.
 */
export async function verifyEventSignature(opts: {
  publicKey: webcrypto.CryptoKey;
  signatureBase64: string;
  signedBytes: Uint8Array;
}): Promise<boolean> {
  let sig: Uint8Array;
  try {
    sig = base64ToBytes(opts.signatureBase64);
  } catch (err) {
    if (err instanceof SignatureError) return false;
    throw err;
  }
  if (sig.length !== ED25519_SIG_BYTES) return false;
  return verifyEd25519(opts.publicKey, sig, opts.signedBytes);
}

// ---------------------------------------------------------------------
// Small base64 helper (accepts both padded and url-safe variants).
// ---------------------------------------------------------------------

function base64ToBytes(input: string): Uint8Array {
  // Normalise url-safe to standard base64.
  const normal = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normal.length % 4 === 0 ? normal : normal + '='.repeat(4 - (normal.length % 4));
  try {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  } catch {
    throw new SignatureError('invalid base64 signature');
  }
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(`signature: ${message}`);
    this.name = 'SignatureError';
  }
}
