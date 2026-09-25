//! CloudPunch canonical JSON — Rust side.
//!
//! Must produce byte-identical output to
//! `packages/event-schema/src/canonicalize.ts` for the same input.
//! Rules (from `packages/event-schema/canonicalization.md`):
//!   - UTF-8 encoding, no BOM.
//!   - Object keys sorted lexicographically (byte order, which
//!     equals JS's UTF-16 code-unit order for the BMP characters we
//!     use in event fields).
//!   - No whitespace outside string values.
//!   - Numbers: integers only.
//!   - String escapes: `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, and
//!     `\u00XX` for the remaining C0 controls. Non-ASCII preserved
//!     as its UTF-8 bytes.
//!   - No trailing commas, no duplicate keys.

use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CanonicalizeError {
    #[error("non-finite number is not representable in canonical JSON")]
    NonFinite,
    #[error("fractional numbers are not permitted in canonical payloads")]
    Fractional,
    #[error("integer outside JS safe-integer range (\u{00b1}(2^53 - 1))")]
    OutsideSafeRange,
    #[error("unsupported JSON value kind")]
    UnsupportedKind,
    #[error("serde_json failure: {0}")]
    Serde(#[from] serde_json::Error),
}

/// Fields covered by the Ed25519 signature (16 fields, sorted
/// lexicographically at write time). This struct is the type-safe
/// interface for callers; internally we canonicalise via serde_json.
#[derive(Debug, Serialize)]
pub struct SignedEventFields<'a> {
    pub app_version: &'a str,
    pub client_ts: &'a str,
    pub correlation_id: &'a str,
    pub device_id: &'a str,
    pub employee_id: &'a str,
    pub event_type: &'a str,
    pub event_ulid: &'a str,
    pub monotonic_ns: i64,
    pub offline_captured: bool,
    pub origin: &'a str,
    pub parent_event_ulid: Option<&'a str>,
    pub payload: &'a Value,
    pub sequence_number: i64,
    pub session_id: &'a str,
    pub tz_iana: &'a str,
    pub utc_offset_minutes: i16,
}

/// Canonicalise a `serde_json::Value` to its byte representation.
///
/// Errors on non-integer numbers, integers outside JS safe-integer
/// range, or unsupported kinds. Cycles cannot occur because
/// `serde_json::Value` is an owned tree.
pub fn canonicalize(value: &Value) -> Result<Vec<u8>, CanonicalizeError> {
    let mut out = Vec::with_capacity(256);
    write_value(value, &mut out)?;
    Ok(out)
}

/// Canonicalise a `SignedEventFields` to bytes suitable for signing
/// or signature verification. Convenience over `canonicalize` for the
/// most common caller.
pub fn canonicalize_signed_fields(
    event: &SignedEventFields<'_>,
) -> Result<Vec<u8>, CanonicalizeError> {
    let value = serde_json::to_value(event)?;
    canonicalize(&value)
}

fn write_value(v: &Value, out: &mut Vec<u8>) -> Result<(), CanonicalizeError> {
    match v {
        Value::Null => {
            out.extend_from_slice(b"null");
            Ok(())
        }
        Value::Bool(true) => {
            out.extend_from_slice(b"true");
            Ok(())
        }
        Value::Bool(false) => {
            out.extend_from_slice(b"false");
            Ok(())
        }
        Value::Number(n) => write_number(n, out),
        Value::String(s) => {
            write_string(s, out);
            Ok(())
        }
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_value(item, out)?;
            }
            out.push(b']');
            Ok(())
        }
        Value::Object(map) => {
            out.push(b'{');
            // Lexicographic key sort. serde_json::Map iteration order
            // depends on features (`preserve_order` etc.); we sort
            // explicitly to be independent of that.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_string(k, out);
                out.push(b':');
                let child = map
                    .get(k.as_str())
                    .expect("key from map should still resolve");
                write_value(child, out)?;
            }
            out.push(b'}');
            Ok(())
        }
    }
}

fn write_number(n: &serde_json::Number, out: &mut Vec<u8>) -> Result<(), CanonicalizeError> {
    // Reject NaN/Infinity via as_f64 check (serde_json rejects them
    // on parse but be defensive).
    if let Some(f) = n.as_f64() {
        if !f.is_finite() {
            return Err(CanonicalizeError::NonFinite);
        }
    }
    if let Some(i) = n.as_i64() {
        if !within_safe_int(i) {
            return Err(CanonicalizeError::OutsideSafeRange);
        }
        write!(out, "{}", i).map_err(|_| CanonicalizeError::UnsupportedKind)?;
        return Ok(());
    }
    if let Some(u) = n.as_u64() {
        if u > MAX_SAFE_INT_U64 {
            return Err(CanonicalizeError::OutsideSafeRange);
        }
        write!(out, "{}", u).map_err(|_| CanonicalizeError::UnsupportedKind)?;
        return Ok(());
    }
    // Anything else is a fractional number.
    Err(CanonicalizeError::Fractional)
}

/// JS safe-integer bounds: \u{00b1}(2^53 \u{2212} 1). Matches the TS
/// implementation's `Number.MAX_SAFE_INTEGER` check.
const MAX_SAFE_INT_U64: u64 = (1u64 << 53) - 1;
fn within_safe_int(i: i64) -> bool {
    let bound = MAX_SAFE_INT_U64 as i64;
    i >= -bound && i <= bound
}

/// Escape a string per the canonicalisation spec. Iterating over
/// `char`s (Unicode scalar values) is safe because both `"` and `\\`
/// and all C0 control chars are in the BMP and single-scalar.
/// Non-ASCII scalars are preserved via `char::encode_utf8`, which
/// produces the same bytes that TS's `TextEncoder` produces.
fn write_string(s: &str, out: &mut Vec<u8>) {
    out.push(b'"');
    for c in s.chars() {
        match c {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{0008}' => out.extend_from_slice(b"\\b"),
            '\u{0009}' => out.extend_from_slice(b"\\t"),
            '\u{000A}' => out.extend_from_slice(b"\\n"),
            '\u{000C}' => out.extend_from_slice(b"\\f"),
            '\u{000D}' => out.extend_from_slice(b"\\r"),
            c if (c as u32) < 0x20 => {
                // \u00XX for other C0 controls.
                write!(out, "\\u{:04x}", c as u32).expect("writing to Vec<u8> cannot fail");
            }
            c => {
                let mut buf = [0u8; 4];
                let encoded = c.encode_utf8(&mut buf);
                out.extend_from_slice(encoded.as_bytes());
            }
        }
    }
    out.push(b'"');
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn to_utf8(bytes: &[u8]) -> &str {
        std::str::from_utf8(bytes).expect("output must be valid UTF-8")
    }

    #[test]
    fn primitives() {
        assert_eq!(to_utf8(&canonicalize(&json!(null)).unwrap()), "null");
        assert_eq!(to_utf8(&canonicalize(&json!(true)).unwrap()), "true");
        assert_eq!(to_utf8(&canonicalize(&json!(false)).unwrap()), "false");
        assert_eq!(to_utf8(&canonicalize(&json!(0)).unwrap()), "0");
        assert_eq!(to_utf8(&canonicalize(&json!(42)).unwrap()), "42");
        assert_eq!(to_utf8(&canonicalize(&json!(-1)).unwrap()), "-1");
        assert_eq!(
            to_utf8(&canonicalize(&json!(9_007_199_254_740_991_i64)).unwrap()),
            "9007199254740991",
        );
    }

    #[test]
    fn rejects_fractional_and_out_of_range() {
        assert!(matches!(
            canonicalize(&json!(2.5)),
            Err(CanonicalizeError::Fractional)
        ));
        // 2^53 exceeds the safe integer range.
        assert!(matches!(
            canonicalize(&json!(9_007_199_254_740_992_u64)),
            Err(CanonicalizeError::OutsideSafeRange)
        ));
    }

    #[test]
    fn strings_escape_and_utf8() {
        assert_eq!(to_utf8(&canonicalize(&json!("")).unwrap()), "\"\"");
        assert_eq!(
            to_utf8(&canonicalize(&json!("hello")).unwrap()),
            "\"hello\""
        );
        assert_eq!(
            to_utf8(&canonicalize(&json!("a\"b\\c")).unwrap()),
            "\"a\\\"b\\\\c\""
        );
        assert_eq!(
            to_utf8(&canonicalize(&json!("a\nb\tc\rd")).unwrap()),
            "\"a\\nb\\tc\\rd\""
        );
        // Other C0 controls (U+0001..U+001F except \b\t\n\f\r) escape
        // as \u00XX (six chars: backslash u zero zero X X).
        assert_eq!(
            to_utf8(&canonicalize(&json!("\u{0001}")).unwrap()),
            "\"\\u0001\""
        );
        assert_eq!(
            to_utf8(&canonicalize(&json!("\u{001f}")).unwrap()),
            "\"\\u001f\""
        );
        // Preserves UTF-8 for non-ASCII.
        assert_eq!(
            canonicalize(&json!("caf\u{00e9}")).unwrap(),
            vec![0x22, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x22],
        );
        // Emoji U+1F600 encodes as F0 9F 98 80 in UTF-8.
        assert_eq!(
            canonicalize(&json!("\u{1F600}")).unwrap(),
            vec![0x22, 0xf0, 0x9f, 0x98, 0x80, 0x22],
        );
    }

    #[test]
    fn objects_sort_keys_lexicographically() {
        let v = json!({ "b": 1, "a": 2, "c": 3 });
        assert_eq!(
            to_utf8(&canonicalize(&v).unwrap()),
            "{\"a\":2,\"b\":1,\"c\":3}"
        );
        let v = json!({ "": 1, "A": 2, "a": 3, "0": 4 });
        assert_eq!(
            to_utf8(&canonicalize(&v).unwrap()),
            "{\"\":1,\"0\":4,\"A\":2,\"a\":3}"
        );
    }

    #[test]
    fn arrays_preserve_order() {
        assert_eq!(
            to_utf8(&canonicalize(&json!([3, 1, 2])).unwrap()),
            "[3,1,2]"
        );
    }

    /// Golden vector — byte-for-byte match with the TS test in
    /// `packages/event-schema/src/canonicalize.test.ts`
    /// (`canonicalizeSignedFields \u{2014} event subset > produces the
    /// expected canonical byte string`).
    ///
    /// If either implementation changes, this test AND the TS test
    /// update together — the shared byte string is the source of
    /// truth for the signing contract.
    #[test]
    fn cross_language_golden_vector_matches_ts() {
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
        let expected = concat!(
            "{",
            "\"app_version\":\"0.1.0\",",
            "\"client_ts\":\"2026-09-22T09:15:03.412+05:30\",",
            "\"correlation_id\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\",",
            "\"device_id\":\"dddddddd-dddd-dddd-dddd-dddddddddddd\",",
            "\"employee_id\":\"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee\",",
            "\"event_type\":\"USER_CLOCK_IN\",",
            "\"event_ulid\":\"01J8Q00000000000000000000A\",",
            "\"monotonic_ns\":0,",
            "\"offline_captured\":false,",
            "\"origin\":\"user\",",
            "\"parent_event_ulid\":null,",
            "\"payload\":{},",
            "\"sequence_number\":1,",
            "\"session_id\":\"ssssssss-ssss-ssss-ssss-ssssssssssss\",",
            "\"tz_iana\":\"Asia/Kolkata\",",
            "\"utc_offset_minutes\":330",
            "}"
        );
        let bytes = canonicalize_signed_fields(&event).expect("canonicalisation failed");
        assert_eq!(std::str::from_utf8(&bytes).unwrap(), expected);
    }
}
