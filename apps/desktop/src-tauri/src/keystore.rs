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

/// A shared store is a store (sign-in and the key logic share one).
impl<T: SecretStore> SecretStore for std::sync::Arc<T> {
    fn get(&self, slot: &Slot) -> Result<Option<String>, KeystoreError> {
        (**self).get(slot)
    }
    fn set(&self, slot: &Slot, value: &str) -> Result<(), KeystoreError> {
        (**self).set(slot, value)
    }
    fn delete(&self, slot: &Slot) -> Result<(), KeystoreError> {
        (**self).delete(slot)
    }
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

    /// Entra refresh token (ADR-0007 §5: the "MSAL cache" entry).
    pub fn refresh_token(tenant: &str, client: &str, oid: &str) -> Result<Self, KeystoreError> {
        let (tenant, client, oid) = (uuid_str(tenant)?, uuid_str(client)?, uuid_str(oid)?);
        Ok(Self {
            target: format!("CloudPunch/msal/{tenant}/{client}/{oid}"),
            service: "com.cloudpunch.msal",
            user: oid,
        })
    }

    /// The `oid` of the last signed-in user, so the app can sign in
    /// silently at start-up. Not secret, but lives beside the tokens.
    pub fn current_user() -> Self {
        Self {
            target: "CloudPunch/current-user".to_string(),
            service: "com.cloudpunch.current-user",
            user: "current".to_string(),
        }
    }

    fn new(name: &str, service: &'static str, oid: &str) -> Result<Self, KeystoreError> {
        let oid = uuid_str(oid)?;
        Ok(Self {
            target: format!("CloudPunch/{name}/{oid}"),
            service,
            user: oid,
        })
    }
}

/// Normalised hyphenated UUID. A UUID can't smuggle separators into a
/// target name.
fn uuid_str(s: &str) -> Result<String, KeystoreError> {
    Ok(uuid::Uuid::parse_str(s)
        .map_err(|_| KeystoreError::InvalidOid)?
        .hyphenated()
        .to_string())
}

/// The OS secure store via the `keyring` crate. Values longer than one
/// Windows credential can hold are split across several ([`Chunked`]).
pub struct OsStore;

impl SecretStore for OsStore {
    fn get(&self, slot: &Slot) -> Result<Option<String>, KeystoreError> {
        Chunked(RawOs).get(slot)
    }
    fn set(&self, slot: &Slot, value: &str) -> Result<(), KeystoreError> {
        Chunked(RawOs).set(slot, value)
    }
    fn delete(&self, slot: &Slot) -> Result<(), KeystoreError> {
        Chunked(RawOs).delete(slot)
    }
}

/// Characters per stored part. Windows caps a credential blob at 2560
/// bytes and `keyring` stores UTF-16, so one entry holds at most 1280
/// characters; Entra refresh tokens are often longer.
const CHUNK_CHARS: usize = 1000;
const CHUNK_HEADER: &str = "cloudpunch-chunked:v1:";

/// Splits long values across `<target>/part<i>` entries, with a header
/// `cloudpunch-chunked:v1:<n>` at the slot itself. Short values are
/// stored as-is, so existing entries keep working.
pub struct Chunked<S: SecretStore>(pub S);

impl<S: SecretStore> Chunked<S> {
    fn part(slot: &Slot, i: usize) -> Slot {
        Slot {
            target: format!("{}/part{i}", slot.target),
            service: slot.service,
            user: format!("{}#part{i}", slot.user),
        }
    }

    /// Number of parts currently stored (0 if not chunked or missing).
    fn parts(&self, slot: &Slot) -> Result<usize, KeystoreError> {
        Ok(self
            .0
            .get(slot)?
            .and_then(|v| v.strip_prefix(CHUNK_HEADER)?.parse().ok())
            .unwrap_or(0))
    }
}

impl<S: SecretStore> SecretStore for Chunked<S> {
    fn get(&self, slot: &Slot) -> Result<Option<String>, KeystoreError> {
        let Some(head) = self.0.get(slot)? else {
            return Ok(None);
        };
        let Some(count) = head.strip_prefix(CHUNK_HEADER) else {
            return Ok(Some(head));
        };
        let count: usize = count
            .parse()
            .map_err(|_| KeystoreError::Store("bad chunk header".into()))?;
        let mut value = String::new();
        for i in 0..count {
            let part = self
                .0
                .get(&Self::part(slot, i))?
                .ok_or_else(|| KeystoreError::Store("stored value is incomplete".into()))?;
            value.push_str(&part);
        }
        Ok(Some(value))
    }

    fn set(&self, slot: &Slot, value: &str) -> Result<(), KeystoreError> {
        let old = self.parts(slot)?;
        let chars: Vec<char> = value.chars().collect();
        let new = if chars.len() <= CHUNK_CHARS {
            self.0.set(slot, value)?;
            0
        } else {
            let pieces: Vec<String> = chars
                .chunks(CHUNK_CHARS)
                .map(|c| c.iter().collect())
                .collect();
            // Parts first, then the header, so a header never points
            // at parts this write didn't finish.
            for (i, piece) in pieces.iter().enumerate() {
                self.0.set(&Self::part(slot, i), piece)?;
            }
            self.0
                .set(slot, &format!("{CHUNK_HEADER}{}", pieces.len()))?;
            pieces.len()
        };
        for i in new..old {
            self.0.delete(&Self::part(slot, i))?;
        }
        Ok(())
    }

    fn delete(&self, slot: &Slot) -> Result<(), KeystoreError> {
        for i in 0..self.parts(slot)? {
            self.0.delete(&Self::part(slot, i))?;
        }
        self.0.delete(slot)
    }
}

/// One `keyring` entry per slot, no splitting.
struct RawOs;

impl RawOs {
    fn entry(slot: &Slot) -> Result<keyring::Entry, KeystoreError> {
        keyring::Entry::new_with_target(&slot.target, slot.service, &slot.user)
            .map_err(|e| KeystoreError::Store(e.to_string()))
    }
}

impl SecretStore for RawOs {
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
    fn refresh_token_slot_uses_adr_0007_msal_name() {
        let tenant = "a6300e5c-dae4-413c-a6d2-646fbc2aa587";
        let client = "13646e0e-abc6-4779-b8fb-fc10bdfdf4b9";
        let r = Slot::refresh_token(tenant, client, OID).unwrap();
        assert_eq!(r.target, format!("CloudPunch/msal/{tenant}/{client}/{OID}"));
        assert_eq!(r.service, "com.cloudpunch.msal");
        assert!(matches!(
            Slot::refresh_token("x/y", client, OID),
            Err(KeystoreError::InvalidOid)
        ));
        assert_eq!(Slot::current_user().target, "CloudPunch/current-user");
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

    /// A realistic Entra refresh token is well over the 1280 characters
    /// one Windows credential holds.
    fn long_token() -> String {
        (0..3000).map(|i| (b'a' + (i % 26) as u8) as char).collect()
    }

    #[test]
    fn chunked_round_trips_long_values_and_keeps_short_ones_whole() {
        let store = Chunked(MemoryStore::default());
        let slot = Slot::device_key(OID).unwrap();
        store.set(&slot, "short").unwrap();
        assert_eq!(store.0.get(&slot).unwrap().as_deref(), Some("short"));

        let long = long_token();
        store.set(&slot, &long).unwrap();
        assert_eq!(store.get(&slot).unwrap().as_deref(), Some(long.as_str()));
        let header = store.0.get(&slot).unwrap().unwrap();
        assert_eq!(header, "cloudpunch-chunked:v1:3");
        for i in 0..3 {
            let part = store
                .0
                .get(&Chunked::<MemoryStore>::part(&slot, i))
                .unwrap()
                .unwrap();
            assert!(part.chars().count() <= CHUNK_CHARS);
        }
    }

    #[test]
    fn chunked_shrinking_and_delete_leave_no_parts_behind() {
        let store = Chunked(MemoryStore::default());
        let slot = Slot::device_key(OID).unwrap();
        store.set(&slot, &long_token()).unwrap();
        store.set(&slot, &"x".repeat(1500)).unwrap();
        assert!(store
            .0
            .get(&Chunked::<MemoryStore>::part(&slot, 2))
            .unwrap()
            .is_none());
        assert_eq!(store.get(&slot).unwrap().unwrap().len(), 1500);

        store.delete(&slot).unwrap();
        assert!(store.get(&slot).unwrap().is_none());
        for i in 0..3 {
            assert!(store
                .0
                .get(&Chunked::<MemoryStore>::part(&slot, i))
                .unwrap()
                .is_none());
        }
    }

    #[test]
    fn chunked_missing_part_is_an_error_not_a_truncated_value() {
        let store = Chunked(MemoryStore::default());
        let slot = Slot::device_key(OID).unwrap();
        store.set(&slot, &long_token()).unwrap();
        store
            .0
            .delete(&Chunked::<MemoryStore>::part(&slot, 1))
            .unwrap();
        assert!(matches!(store.get(&slot), Err(KeystoreError::Store(_))));
    }

    /// A refresh-token-sized value through the real Credential Manager.
    /// `cargo test -p cloudpunch-desktop --lib keystore_os_long_value -- --ignored`
    #[test]
    #[ignore = "writes to the real OS secure store"]
    fn keystore_os_long_value() {
        let slot = Slot::device_key(&uuid::Uuid::new_v4().to_string()).unwrap();
        let long = long_token();
        OsStore.set(&slot, &long).unwrap();
        assert_eq!(OsStore.get(&slot).unwrap().as_deref(), Some(long.as_str()));
        OsStore.delete(&slot).unwrap();
        assert!(OsStore.get(&slot).unwrap().is_none(), "cleaned up");
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
