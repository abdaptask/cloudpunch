//! Ed25519 event signing helpers.
//!
//! The signing key is generated on-device at first launch and stored
//! in the OS credential store (Windows Credential Manager /
//! macOS Keychain — see slice 2b.3). This module is deliberately
//! agnostic to key storage; callers own key material.
//!
//! Byte layout matches the backend verifier in
//! `packages/event-schema/src/signature.ts`:
//!   - Public key: 32 bytes (raw Ed25519 point encoding)
//!   - Signature: 64 bytes (raw Ed25519 signature)

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use thiserror::Error;

pub const PUBLIC_KEY_LEN: usize = 32;
pub const SIGNATURE_LEN: usize = 64;

#[derive(Debug, Error)]
pub enum SignatureError {
    #[error("expected {expected}-byte input, got {actual}")]
    WrongLength { expected: usize, actual: usize },
    #[error("Ed25519 verification failed")]
    VerifyFailed,
}

/// Sign an arbitrary byte slice with the given Ed25519 signing key.
/// Returns the raw 64-byte signature.
///
/// The desktop calls this over the canonicalised bytes produced by
/// `canonicalize_signed_fields`.
pub fn sign_bytes(signing_key: &SigningKey, bytes: &[u8]) -> [u8; SIGNATURE_LEN] {
    signing_key.sign(bytes).to_bytes()
}

/// Verify an Ed25519 signature over `bytes` using a raw 32-byte
/// public key. Returns `Ok(())` on success. Cryptographic failure
/// returns `VerifyFailed`; malformed inputs return `WrongLength`.
pub fn verify_bytes(
    public_key_raw: &[u8],
    bytes: &[u8],
    signature_raw: &[u8],
) -> Result<(), SignatureError> {
    if public_key_raw.len() != PUBLIC_KEY_LEN {
        return Err(SignatureError::WrongLength {
            expected: PUBLIC_KEY_LEN,
            actual: public_key_raw.len(),
        });
    }
    if signature_raw.len() != SIGNATURE_LEN {
        return Err(SignatureError::WrongLength {
            expected: SIGNATURE_LEN,
            actual: signature_raw.len(),
        });
    }
    let pk_array: [u8; PUBLIC_KEY_LEN] = public_key_raw
        .try_into()
        .expect("length checked immediately above");
    let sig_array: [u8; SIGNATURE_LEN] = signature_raw
        .try_into()
        .expect("length checked immediately above");
    let verifying_key =
        VerifyingKey::from_bytes(&pk_array).map_err(|_| SignatureError::VerifyFailed)?;
    let signature = Signature::from_bytes(&sig_array);
    verifying_key
        .verify(bytes, &signature)
        .map_err(|_| SignatureError::VerifyFailed)
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    fn keypair() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    #[test]
    fn sign_and_verify_round_trip() {
        let sk = keypair();
        let pk = sk.verifying_key().to_bytes();
        let data = b"cloudpunch signed message";
        let sig = sign_bytes(&sk, data);
        assert!(verify_bytes(&pk, data, &sig).is_ok());
    }

    #[test]
    fn verify_rejects_tampered_signature() {
        let sk = keypair();
        let pk = sk.verifying_key().to_bytes();
        let data = b"cloudpunch signed message";
        let mut sig = sign_bytes(&sk, data);
        sig[0] ^= 0x01;
        assert!(matches!(
            verify_bytes(&pk, data, &sig),
            Err(SignatureError::VerifyFailed)
        ));
    }

    #[test]
    fn verify_rejects_tampered_data() {
        let sk = keypair();
        let pk = sk.verifying_key().to_bytes();
        let sig = sign_bytes(&sk, b"original");
        assert!(matches!(
            verify_bytes(&pk, b"tampered", &sig),
            Err(SignatureError::VerifyFailed)
        ));
    }

    #[test]
    fn verify_rejects_wrong_length_key_or_sig() {
        let sk = keypair();
        let pk = sk.verifying_key().to_bytes();
        let sig = sign_bytes(&sk, b"x");
        // Short public key
        assert!(matches!(
            verify_bytes(&pk[..31], b"x", &sig),
            Err(SignatureError::WrongLength { .. })
        ));
        // Short signature
        assert!(matches!(
            verify_bytes(&pk, b"x", &sig[..63]),
            Err(SignatureError::WrongLength { .. })
        ));
    }

    #[test]
    fn end_to_end_over_canonicalised_event() {
        use crate::event::canonicalize::{canonicalize_signed_fields, SignedEventFields};
        use serde_json::json;

        let sk = keypair();
        let pk = sk.verifying_key().to_bytes();
        let payload = json!({});
        let event = SignedEventFields {
            app_version: "0.1.0",
            client_ts: "2026-09-22T09:15:03.412+05:30",
            correlation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            device_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
            employee_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
            event_type: "USER_CLOCK_IN",
            event_ulid: "01J8Q00000000000000000000A",
            monotonic_ns: 0,
            offline_captured: false,
            origin: "user",
            parent_event_ulid: None,
            payload: &payload,
            sequence_number: 1,
            session_id: "ssssssss-ssss-ssss-ssss-ssssssssssss",
            tz_iana: "Asia/Kolkata",
            utc_offset_minutes: 330,
        };
        let bytes = canonicalize_signed_fields(&event).unwrap();
        let sig = sign_bytes(&sk, &bytes);
        assert!(verify_bytes(&pk, &bytes, &sig).is_ok());
    }
}
