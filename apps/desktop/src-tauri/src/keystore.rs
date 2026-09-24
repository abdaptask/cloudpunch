//! Device secrets in the OS secure store (ADR-0007 §5, ADR-0004 §5).
//!
//! Two per-user secrets live here, keyed by the signed-in Entra `oid`:
//!   - the **device key**: Ed25519 private key that signs every event;
//!   - the **outbox key**: 32-byte SQLCipher key for the local outbox.
//!
//! Both are generated on first use from the OS CSPRNG, stored
//! base64url-encoded, and reused afterwards. They never leave the
//! secure store except into this process's memory. Sign-out calls
//! [`Secrets::forget`], which deletes both; the next sign-in makes new
//! ones (and the device re-enrols with the new public key).
//!
//! Storage names (ADR-0007 §5):
//!
//! | Secret | Windows Credential Manager target | macOS Keychain service |
//! |---|---|---|
//! | device key | `CloudPunch/device-key/<oid>` | `com.cloudpunch.device-key` |
//! | outbox key | `CloudPunch/sqlite-key/<oid>` | `com.cloudpunch.sqlite-key` |
//!
//! The macOS account name is the `oid`.
//!
//! Not wired into the app yet: sign-in (2b.4 F2) supplies the `oid`.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::SigningKey;
use thiserror::Error;

/// Both secrets are exactly 32 bytes.
pub const SECRET_LEN: usize = 32;

#[derive(Debug, Error)]
pub enum KeystoreError {
    #[error("oid must be a UUID")]
    InvalidOid,
    /// A stored value exists but isn't 32 bytes of base64url. Never
    /// overwritten automatically: replacing the outbox key would make
    /// the existing outbox unreadable.
    #[error("stored {0} is corrupt")]
    Corrupt(&'static str),
    #[error("secure store: {0}")]
    Store(String),
    #[error("random number generator failed: {0}")]
    Rng(String),
}

/// Minimal secure-store interface, so the key logic is testable
/// without touching the real Credential Manager.
pub trait SecretStore: Send + Sync {
    fn get(&self, slot: &Slot) -> Result<Option<String>, KeystoreError>;
    fn set(&self, slot: &Slot, value: &str) -> Result<(), KeystoreError>;
    /// Deleting a missing entry is not an error.
    fn delete(&self, slot: &Slot) -> Result<(), KeystoreError>;
}

/// One named secret for one user.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Slot {
    /// Windows Credential Manager target name.
    pub target: String,
    /// macOS Keychain service.
    pub service: &'static str,
    /// macOS Keychain account (the `oid`).
    pub user: String,
}

impl Slot {
    pub fn device_key(oid: &str) -> Result<Self, KeystoreError> {
        Self::new("device-key", "com.cloudpunch.device-key", oid)
    }

    pub fn outbox_key(oid: &str) -> Result<Self, KeystoreError> {
        Self::new("sqlite-key", "com.cloudpunch.sqlite-key", oid)
    }

    fn new(name: &str, service: &'static str, oid: &str) -> Result<Self, KeystoreError> {
        // A UUID can't smuggle separators into the target name.
        let oid = uuid::Uuid::parse_str(oid)
            .map_err(|_| KeystoreError::InvalidOid)?
            .hyphenated()
            .to_string();
        Ok(Self {
            target: format!("CloudPunch/{name}/{oid}"),
            service,
            user: oid,
        })
    }
}

/// The OS secure store via the `keyring` crate.
pub struct OsStore;

impl OsStore {
    fn entry(slot: &Slot) -> Result<keyring::Entry, KeystoreError> {
        keyring::Entry::new_with_target(&slot.target, slot.service, &slot.user)
            .map_err(|e| KeystoreError::Store(e.to_string()))
    }
}

impl SecretStore for OsStore {
    fn get(&self, slot: &Slot) -> Result<Option<String>, KeystoreError> {
        match Self::entry(slot)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(KeystoreError::Store(e.to_string())),
        }
    }

    fn set(&self, slot: &Slot, value: &str) -> Result<(), KeystoreError> {
        Self::entry(slot)?
            .set_password(value)
            .map_err(|e| KeystoreError::Store(e.to_string()))
    }

    fn delete(&self, slot: &Slot) -> Result<(), KeystoreError> {
        match Self::entry(slot)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(KeystoreError::Store(e.to_string())),
        }
    }
}

/// In-memory store for tests.
#[derive(Debug, Default)]
pub struct MemoryStore {
    values: Mutex<HashMap<Slot, String>>,
}

impl SecretStore for MemoryStore {
    fn get(&self, slot: &Slot) -> Result<Option<String>, KeystoreError> {
        Ok(self.values.lock().expect("memory store").get(slot).cloned())
    }
    fn set(&self, slot: &Slot, value: &str) -> Result<(), KeystoreError> {
        self.values
            .lock()
            .expect("memory store")
            .insert(slot.clone(), value.to_string());
        Ok(())
    }
    fn delete(&self, slot: &Slot) -> Result<(), KeystoreError> {
        self.values.lock().expect("memory store").remove(slot);
        Ok(())
    }
}

/// A user's device secrets.
pub struct Secrets<S: SecretStore> {
    store: S,
}

impl<S: SecretStore> Secrets<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    /// The device signing key for `oid`, created on first use.
    pub fn device_key(&self, oid: &str) -> Result<SigningKey, KeystoreError> {
        let bytes = self.load_or_create(&Slot::device_key(oid)?, "device key")?;
        Ok(SigningKey::from_bytes(&bytes))
    }

    /// The outbox (SQLCipher) key for `oid`, created on first use.
    pub fn outbox_key(&self, oid: &str) -> Result<[u8; SECRET_LEN], KeystoreError> {
        self.load_or_create(&Slot::outbox_key(oid)?, "outbox key")
    }

    /// Delete both secrets for `oid` (sign-out).
    pub fn forget(&self, oid: &str) -> Result<(), KeystoreError> {
        self.store.delete(&Slot::device_key(oid)?)?;
        self.store.delete(&Slot::outbox_key(oid)?)
    }

    fn load_or_create(
        &self,
        slot: &Slot,
        what: &'static str,
    ) -> Result<[u8; SECRET_LEN], KeystoreError> {
        if let Some(stored) = self.store.get(slot)? {
            return decode(&stored).ok_or(KeystoreError::Corrupt(what));
        }
        let mut bytes = [0u8; SECRET_LEN];
        getrandom::fill(&mut bytes).map_err(|e| KeystoreError::Rng(e.to_string()))?;
        self.store.set(slot, &URL_SAFE_NO_PAD.encode(bytes))?;
        Ok(bytes)
    }
}

fn decode(stored: &str) -> Option<[u8; SECRET_LEN]> {
    URL_SAFE_NO_PAD.decode(stored.trim()).ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

    fn secrets() -> Secrets<MemoryStore> {
        Secrets::new(MemoryStore::default())
    }

    #[test]
    fn slots_use_adr_0007_names() {
        let d = Slot::device_key(OID).unwrap();
        assert_eq!(d.target, format!("CloudPunch/device-key/{OID}"));
        assert_eq!(d.service, "com.cloudpunch.device-key");
        assert_eq!(d.user, OID);
        let o = Slot::outbox_key(OID).unwrap();
        assert_eq!(o.target, format!("CloudPunch/sqlite-key/{OID}"));
        assert_eq!(o.service, "com.cloudpunch.sqlite-key");
    }

    #[test]
    fn oid_must_be_a_uuid_and_is_normalised() {
        assert!(matches!(
            Slot::device_key("x/../../evil"),
            Err(KeystoreError::InvalidOid)
        ));
        let upper = Slot::device_key(&OID.to_uppercase()).unwrap();
        assert_eq!(upper.user, OID);
    }

    #[test]
    fn device_key_is_created_once_and_reused() {
        let s = secrets();
        let first = s.device_key(OID).unwrap();
        let again = s.device_key(OID).unwrap();
        assert_eq!(first.to_bytes(), again.to_bytes());
        assert_eq!(first.verifying_key(), again.verifying_key());
    }

    #[test]
    fn outbox_key_is_created_once_and_differs_from_device_key() {
        let s = secrets();
        let a = s.outbox_key(OID).unwrap();
        assert_eq!(a, s.outbox_key(OID).unwrap());
        assert_ne!(a, s.device_key(OID).unwrap().to_bytes());
    }

    #[test]
    fn keys_are_per_user() {
        let s = secrets();
        let other = "1f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
        assert_ne!(s.outbox_key(OID).unwrap(), s.outbox_key(other).unwrap());
    }

    #[test]
    fn stored_value_is_base64url_32_bytes() {
        let s = secrets();
        let key = s.outbox_key(OID).unwrap();
        let stored = s
            .store
            .get(&Slot::outbox_key(OID).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(stored.len(), 43);
        assert!(!stored.contains(['+', '/', '=']));
        assert_eq!(decode(&stored), Some(key));
    }

    #[test]
    fn corrupt_value_is_reported_not_replaced() {
        let s = secrets();
        let slot = Slot::outbox_key(OID).unwrap();
        s.store.set(&slot, "not-a-key").unwrap();
        assert!(matches!(
            s.outbox_key(OID),
            Err(KeystoreError::Corrupt("outbox key"))
        ));
        assert_eq!(s.store.get(&slot).unwrap().as_deref(), Some("not-a-key"));
    }

    #[test]
    fn forget_deletes_both_and_next_use_makes_new_ones() {
        let s = secrets();
        let old_device = s.device_key(OID).unwrap().to_bytes();
        let old_outbox = s.outbox_key(OID).unwrap();
        s.forget(OID).unwrap();
        assert!(s
            .store
            .get(&Slot::device_key(OID).unwrap())
            .unwrap()
            .is_none());
        assert!(s
            .store
            .get(&Slot::outbox_key(OID).unwrap())
            .unwrap()
            .is_none());
        assert_ne!(s.device_key(OID).unwrap().to_bytes(), old_device);
        assert_ne!(s.outbox_key(OID).unwrap(), old_outbox);
        // Forgetting twice is fine.
        s.forget(OID).unwrap();
        s.forget(OID).unwrap();
    }

    /// Round trip through the real OS store with a throwaway oid;
    /// cleans up after itself.
    /// `cargo test -p cloudpunch-desktop --lib keystore_os_round_trip -- --ignored`
    #[test]
    #[ignore = "writes to the real OS secure store"]
    fn keystore_os_round_trip() {
        let oid = uuid::Uuid::new_v4().to_string();
        let s = Secrets::new(OsStore);
        let key = s.outbox_key(&oid).unwrap();
        assert_eq!(s.outbox_key(&oid).unwrap(), key, "persisted and reloaded");
        let device = s.device_key(&oid).unwrap();
        assert_eq!(s.device_key(&oid).unwrap().to_bytes(), device.to_bytes());
        s.forget(&oid).unwrap();
        let slot = Slot::outbox_key(&oid).unwrap();
        assert!(OsStore.get(&slot).unwrap().is_none(), "cleaned up");
    }
}
