//! Wire-level payroll-state transitions — a Rust mirror of
//! `apps/backend/src/events/state-machine.ts::nextState`.
//!
//! The desktop core runs every event it is about to emit through
//! [`next_payroll_state`] so it never records a transition the server
//! would reject. Both implementations are checked against the shared
//! fixture `packages/event-schema/fixtures/state-transitions.json`.
//!
//! ADR-0003 §3, amended by ADR-0008 (input keeps the prompt up) and
//! ADR-0009 (`ON_CALL` via `MEDIA_DEVICE_STATE { in_use }`).

use serde_json::Value;

/// The server's payroll states. `Closed` is the session-ended state;
/// the desktop maps it to "clocked out".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayrollState {
    Active,
    OnCall,
    OnBreak,
    Away,
    IdlePending,
    Closed,
}

impl PayrollState {
    /// Wire name, as used by the backend and the fixture.
    pub fn as_str(self) -> &'static str {
        match self {
            PayrollState::Active => "ACTIVE",
            PayrollState::OnCall => "ON_CALL",
            PayrollState::OnBreak => "ON_BREAK",
            PayrollState::Away => "AWAY",
            PayrollState::IdlePending => "IDLE_PENDING",
            PayrollState::Closed => "CLOSED",
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "ACTIVE" => PayrollState::Active,
            "ON_CALL" => PayrollState::OnCall,
            "ON_BREAK" => PayrollState::OnBreak,
            "AWAY" => PayrollState::Away,
            "IDLE_PENDING" => PayrollState::IdlePending,
            "CLOSED" => PayrollState::Closed,
            _ => return None,
        })
    }
}

/// Recorded but never change payroll state. Must match
/// `AMBIENT_EVENTS` in the backend.
const AMBIENT_EVENTS: &[&str] = &[
    "SYSTEM_LOCK",
    "SYSTEM_UNLOCK",
    "SYSTEM_SLEEP",
    "SYSTEM_WAKE",
    "NETWORK_OFFLINE",
    "NETWORK_ONLINE",
    "SERVER_ACK",
    "SERVER_REJECT",
    "CLOCK_DRIFT_DETECTED",
    "SESSION_RECOVERED",
    "INTEGRITY_VIOLATION",
];

/// Next payroll state for `event_type` with `payload`, or `None` if
/// the server would reject the transition (`state_transition_invalid`).
pub fn next_payroll_state(
    current: PayrollState,
    event_type: &str,
    payload: Option<&Value>,
) -> Option<PayrollState> {
    use PayrollState::*;

    if AMBIENT_EVENTS.contains(&event_type) {
        return Some(current);
    }
    let field = |k: &str| payload.and_then(|p| p.get(k));

    match event_type {
        // Never changes state; does not dismiss the prompt (ADR-0008).
        "INPUT_ACTIVITY" => Some(current),

        "MEDIA_DEVICE_STATE" => {
            let in_use = field("in_use")?.as_bool()?;
            Some(match (in_use, current) {
                (true, Active | IdlePending) => OnCall,
                (false, OnCall) => Active,
                _ => current,
            })
        }

        // The session is created before the state machine sees it, so
        // a USER_CLOCK_IN reaching here is always a duplicate.
        "USER_CLOCK_IN" => None,

        "USER_CLOCK_OUT" => (current != Closed).then_some(Closed),

        "USER_START_BREAK" => matches!(current, Active | OnCall).then_some(OnBreak),
        "USER_END_BREAK" => (current == OnBreak).then_some(Active),
        "USER_MARK_AWAY" => (current == Active).then_some(Away),
        "USER_MARK_BACK" => (current == Away).then_some(Active),
        "INPUT_IDLE_5M" => (current == Active).then_some(IdlePending),
        "PROMPT_TIMEOUT_30S" => (current == IdlePending).then_some(Closed),

        "USER_PROMPT_RESPONSE" => {
            if current != IdlePending {
                return None;
            }
            match field("response")?.as_str()? {
                "still_working" => Some(Active),
                "bio_break" | "meal_break" => Some(OnBreak),
                "on_phone_call" | "working_away" => Some(Away),
                "end_shift" => Some(Closed),
                _ => None,
            }
        }

        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str =
        include_str!("../../../../../packages/event-schema/fixtures/state-transitions.json");

    #[test]
    fn matches_shared_fixture() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is valid JSON");
        let cases = fixture["cases"].as_array().expect("fixture has cases");
        assert!(!cases.is_empty());

        let mut failures = Vec::new();
        for c in cases {
            let from = PayrollState::from_wire(c["from"].as_str().unwrap())
                .unwrap_or_else(|| panic!("unknown from-state in {c}"));
            let event_type = c["event_type"].as_str().unwrap();
            let payload = match &c["payload"] {
                Value::Null => None,
                p => Some(p),
            };
            let expected = c["to"].as_str().map(|s| {
                PayrollState::from_wire(s).unwrap_or_else(|| panic!("unknown to-state in {c}"))
            });
            let actual = next_payroll_state(from, event_type, payload);
            if actual != expected {
                failures.push(format!("{c}: got {actual:?}"));
            }
        }
        assert!(
            failures.is_empty(),
            "fixture mismatches:\n{}",
            failures.join("\n")
        );
    }

    #[test]
    fn wire_names_round_trip() {
        use PayrollState::*;
        for s in [Active, OnCall, OnBreak, Away, IdlePending, Closed] {
            assert_eq!(PayrollState::from_wire(s.as_str()), Some(s));
        }
        assert_eq!(PayrollState::from_wire("CLOCKED_OUT"), None);
    }
}
