//! Event canonicalisation and Ed25519 signing for the CloudPunch
//! desktop agent.
//!
//! Byte-level compatibility with the backend implementation in
//! `packages/event-schema/src/canonicalize.ts` is a first-class
//! requirement per ADR-0004 §5. The golden-vector test in
//! `canonicalize.rs` asserts a byte-for-byte match against the same
//! sample the TS test in `packages/event-schema/src/canonicalize.test.ts`
//! uses.

pub mod canonicalize;
pub mod signature;
