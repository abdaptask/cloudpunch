import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalizeSignedFields } from './canonicalize.js';
import {
  SignatureError,
  importEd25519PublicKey,
  verifyEd25519,
  verifyEventSignature,
} from './signature.js';

let signerPrivate: webcrypto.CryptoKey;
let publicKeyRaw: Uint8Array;
let publicKey: webcrypto.CryptoKey;

beforeAll(async () => {
  // Ed25519 is asymmetric; TypeScript's WebCrypto types return the union
  // CryptoKey | CryptoKeyPair for generateKey, so we cast to the pair.
  const kp = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  signerPrivate = kp.privateKey;
  const rawArrayBuffer = await webcrypto.subtle.exportKey('raw', kp.publicKey);
  publicKeyRaw = new Uint8Array(rawArrayBuffer);
  publicKey = await importEd25519PublicKey(publicKeyRaw);
});

async function sign(bytes: Uint8Array): Promise<Uint8Array> {
  const sig = await webcrypto.subtle.sign({ name: 'Ed25519' }, signerPrivate, bytes);
  return new Uint8Array(sig);
}

describe('importEd25519PublicKey', () => {
  it('rejects a wrong-length raw key', async () => {
    await expect(importEd25519PublicKey(new Uint8Array(31))).rejects.toBeInstanceOf(SignatureError);
    await expect(importEd25519PublicKey(new Uint8Array(33))).rejects.toBeInstanceOf(SignatureError);
  });

  it('imports a valid 32-byte key', async () => {
    const key = await importEd25519PublicKey(publicKeyRaw);
    expect(key.algorithm).toMatchObject({ name: 'Ed25519' });
  });
});

describe('verifyEd25519', () => {
  it('returns true for a valid signature', async () => {
    const data = new TextEncoder().encode('hello, cloudpunch');
    const sig = await sign(data);
    expect(await verifyEd25519(publicKey, sig, data)).toBe(true);
  });

  it('returns false for a signature over different bytes', async () => {
    const dataA = new TextEncoder().encode('event A');
    const dataB = new TextEncoder().encode('event B');
    const sig = await sign(dataA);
    expect(await verifyEd25519(publicKey, sig, dataB)).toBe(false);
  });

  it('returns false when the signature is tampered', async () => {
    const data = new TextEncoder().encode('hello');
    const sig = await sign(data);
    sig[0] = sig[0]! ^ 0x01;
    expect(await verifyEd25519(publicKey, sig, data)).toBe(false);
  });

  it('throws on wrong-length signature', async () => {
    const data = new TextEncoder().encode('hello');
    await expect(verifyEd25519(publicKey, new Uint8Array(63), data)).rejects.toBeInstanceOf(
      SignatureError,
    );
  });
});

describe('verifyEventSignature — event round-trip', () => {
  const event = {
    app_version: '0.1.0',
    client_ts: '2026-09-22T09:15:03.412+05:30',
    correlation_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    device_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    employee_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    event_type: 'USER_CLOCK_IN',
    event_ulid: '01J8Q00000000000000000000A',
    monotonic_ns: 0,
    offline_captured: false,
    origin: 'user',
    parent_event_ulid: null,
    payload: {},
    sequence_number: 1,
    session_id: 'ssssssss-ssss-ssss-ssss-ssssssssssss',
    tz_iana: 'Asia/Kolkata',
    utc_offset_minutes: 330,
  } as const;

  it('accepts a signature over the canonical bytes', async () => {
    const bytes = canonicalizeSignedFields(event);
    const sig = await sign(bytes);
    const sigB64 = Buffer.from(sig).toString('base64');
    const ok = await verifyEventSignature({
      publicKey,
      signatureBase64: sigB64,
      signedBytes: bytes,
    });
    expect(ok).toBe(true);
  });

  it('rejects when the event payload is mutated after signing', async () => {
    const bytes = canonicalizeSignedFields(event);
    const sig = await sign(bytes);
    const sigB64 = Buffer.from(sig).toString('base64');

    const tamperedBytes = canonicalizeSignedFields({ ...event, sequence_number: 2 });
    const ok = await verifyEventSignature({
      publicKey,
      signatureBase64: sigB64,
      signedBytes: tamperedBytes,
    });
    expect(ok).toBe(false);
  });

  it('rejects when the signature is malformed base64', async () => {
    const bytes = canonicalizeSignedFields(event);
    const ok = await verifyEventSignature({
      publicKey,
      signatureBase64: '!!!not-base64!!!',
      signedBytes: bytes,
    });
    expect(ok).toBe(false);
  });

  it('rejects when the signature has the wrong length after decode', async () => {
    const bytes = canonicalizeSignedFields(event);
    const shortSig = Buffer.from(new Uint8Array(32)).toString('base64');
    const ok = await verifyEventSignature({
      publicKey,
      signatureBase64: shortSig,
      signedBytes: bytes,
    });
    expect(ok).toBe(false);
  });

  it('supports url-safe base64 (- and _) equivalently', async () => {
    const bytes = canonicalizeSignedFields(event);
    const sig = await sign(bytes);
    const urlSafe = Buffer.from(sig).toString('base64url');
    const ok = await verifyEventSignature({
      publicKey,
      signatureBase64: urlSafe,
      signedBytes: bytes,
    });
    expect(ok).toBe(true);
  });
});
