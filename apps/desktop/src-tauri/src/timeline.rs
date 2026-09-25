//! Today's timeline for the home window: consecutive segments of
//! working / on a call / break / away / prompt, built from state
//! changes. Calls get their own segment here, on the employee's own
//! screen only; reports and manager views still count them as active
//! (ADR-0011, ADR-0003 §1).
//!
//! Display only. These are *tracked* periods on this device, not
//! payable hours — payroll rules (bio-break cap, unpaid meal, prompt
//! classification) are applied server-side from the event ledger.
//!
//! Kept in memory and journaled per day in the user's encrypted outbox
//! (`Timeline::to_json` / `restore`), so quitting or restarting the app
//! keeps today's history. A segment a crash left open is closed at the
//! last heartbeat, where the server closes the recovered session.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::machine::{AwayReason, BreakKind, CallType, CoreState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentKind {
    /// Active, no call.
    Working,
    /// Mic or camera in use, by kind of call (ADR-0012).
    OnCall(CallType),
    Break(BreakKind),
    Away(AwayReason),
    /// Idle prompt showing.
    Prompt,
}

impl SegmentKind {
    fn of(state: CoreState, call_type: Option<CallType>) -> Option<Self> {
        Some(match state {
            CoreState::ClockedOut => return None,
            CoreState::Active => SegmentKind::Working,
            CoreState::OnCall => SegmentKind::OnCall(call_type.unwrap_or(CallType::Other)),
            CoreState::IdlePending { .. } => SegmentKind::Prompt,
            CoreState::OnBreak { kind } => SegmentKind::Break(kind),
            CoreState::Away { reason } => SegmentKind::Away(reason),
        })
    }

    /// Every kind, for parsing stored segments.
    const ALL: [SegmentKind; 11] = [
        SegmentKind::Working,
        SegmentKind::OnCall(CallType::Teams),
        SegmentKind::OnCall(CallType::Zoom),
        SegmentKind::OnCall(CallType::Other),
        SegmentKind::Break(BreakKind::Bio),
        SegmentKind::Break(BreakKind::Meal),
        SegmentKind::Break(BreakKind::Other),
        SegmentKind::Away(AwayReason::PhoneCall),
        SegmentKind::Away(AwayReason::WorkingAway),
        SegmentKind::Away(AwayReason::Meeting),
        SegmentKind::Prompt,
    ];

    pub fn from_wire(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SegmentKind::Working => "working",
            SegmentKind::OnCall(CallType::Teams) => "call_teams",
            SegmentKind::OnCall(CallType::Zoom) => "call_zoom",
            SegmentKind::OnCall(CallType::Other) => "call_other",
            SegmentKind::Break(BreakKind::Bio) => "bio_break",
            SegmentKind::Break(BreakKind::Meal) => "meal_break",
            SegmentKind::Break(BreakKind::Other) => "other_break",
            SegmentKind::Away(AwayReason::PhoneCall) => "away_phone",
            SegmentKind::Away(AwayReason::WorkingAway) => "away_working",
            SegmentKind::Away(AwayReason::Meeting) => "away_meeting",
            SegmentKind::Prompt => "prompt",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub kind: SegmentKind,
    pub started_at: SystemTime,
    pub ended_at: Option<SystemTime>,
    /// 1-based clock-in number since the app started; segments of one
    /// clock-in → clock-out share it.
    pub session: u32,
}

/// Serialised form. Timestamps are epoch ms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentView {
    pub kind: &'static str,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub session: u32,
}

#[derive(Debug, Default)]
pub struct Timeline {
    segments: Vec<Segment>,
    session_started_at: Option<SystemTime>,
    sessions: u32,
}

impl Timeline {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that the core is now in `state` as of `at`; a call with
    /// no known kind counts as [`CallType::Other`].
    pub fn on_state(&mut self, state: CoreState, at: SystemTime) {
        self.record(state, None, at);
    }

    /// Record `state` (and, while on a call, its kind) as of `at`.
    /// Consecutive identical kinds merge; a new kind of call mid-call
    /// starts a new segment.
    pub fn record(&mut self, state: CoreState, call_type: Option<CallType>, at: SystemTime) {
        let kind = SegmentKind::of(state, call_type);
        if let Some(open) = self.segments.last() {
            if open.ended_at.is_none() && Some(open.kind) == kind {
                return;
            }
        }
        self.close_open(at);
        match kind {
            None => self.session_started_at = None,
            Some(kind) => {
                if self.session_started_at.is_none() {
                    self.session_started_at = Some(at);
                    self.sessions += 1;
                }
                self.segments.push(Segment {
                    kind,
                    started_at: at,
                    ended_at: None,
                    session: self.sessions,
                });
            }
        }
    }

    fn close_open(&mut self, at: SystemTime) {
        if let Some(open) = self.segments.last_mut() {
            if open.ended_at.is_none() {
                open.ended_at = Some(at);
            }
        }
    }

    pub fn session_started_at(&self) -> Option<SystemTime> {
        self.session_started_at
    }

    /// Start of the segment still open, if any (for break length).
    pub fn open_segment_started_at(&self) -> Option<SystemTime> {
        self.segments
            .last()
            .filter(|s| s.ended_at.is_none())
            .map(|s| s.started_at)
    }

    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }

    /// Whether any segment is still open or ended after `t` (e.g. local
    /// midnight: "anything tracked today?").
    pub fn any_since(&self, t: SystemTime) -> bool {
        self.segments.iter().any(|s| match s.ended_at {
            None => true,
            Some(e) => e > t,
        })
    }

    /// Forget everything (sign-out: the next user starts clean).
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// The journal form of today's segments.
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.views()).unwrap_or_else(|_| "[]".into())
    }

    /// Load a journaled day into an **empty** timeline (a live day is
    /// never overwritten). A segment still open — the app stopped
    /// without clocking out — is closed at `close_open_at`, never
    /// before it started. Returns whether anything was restored.
    pub fn restore(&mut self, json: &str, close_open_at: SystemTime) -> bool {
        if !self.segments.is_empty() {
            return false;
        }
        let stored: Vec<StoredSegment> = serde_json::from_str(json).unwrap_or_default();
        let mut segments: Vec<Segment> = stored
            .into_iter()
            .filter_map(|s| {
                Some(Segment {
                    kind: SegmentKind::from_wire(&s.kind)?,
                    started_at: from_epoch_ms(s.started_at),
                    ended_at: s.ended_at.map(from_epoch_ms),
                    session: s.session,
                })
            })
            .collect();
        for seg in &mut segments {
            if seg.ended_at.is_none() {
                seg.ended_at = Some(close_open_at.max(seg.started_at));
            }
        }
        if segments.is_empty() {
            return false;
        }
        self.sessions = segments.iter().map(|s| s.session).max().unwrap_or(0);
        self.session_started_at = None;
        self.segments = segments;
        true
    }

    pub fn views(&self) -> Vec<SegmentView> {
        self.segments
            .iter()
            .map(|s| SegmentView {
                kind: s.kind.as_str(),
                started_at: epoch_ms(s.started_at),
                ended_at: s.ended_at.map(epoch_ms),
                session: s.session,
            })
            .collect()
    }
}

/// A journaled segment (the serialised [`SegmentView`]).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSegment {
    kind: String,
    started_at: u64,
    ended_at: Option<u64>,
    session: u32,
}

fn from_epoch_ms(ms: u64) -> SystemTime {
    UNIX_EPOCH + std::time::Duration::from_millis(ms)
}

pub fn epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn t(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    fn kinds(tl: &Timeline) -> Vec<&'static str> {
        tl.segments().iter().map(|s| s.kind.as_str()).collect()
    }

    #[test]
    fn clock_in_opens_working_and_session() {
        let mut tl = Timeline::new();
        tl.on_state(CoreState::Active, t(100));
        assert_eq!(kinds(&tl), ["working"]);
        assert_eq!(tl.session_started_at(), Some(t(100)));
        assert_eq!(tl.segments()[0].ended_at, None);
    }

    #[test]
    fn calls_get_their_own_segment() {
        let mut tl = Timeline::new();
        tl.on_state(CoreState::Active, t(0));
        tl.record(CoreState::OnCall, Some(CallType::Teams), t(60));
        tl.on_state(CoreState::Active, t(120));
        assert_eq!(kinds(&tl), ["working", "call_teams", "working"]);
        assert_eq!(tl.segments()[1].ended_at, Some(t(120)));
    }

    #[test]
    fn switching_call_app_starts_a_new_segment() {
        let mut tl = Timeline::new();
        tl.record(CoreState::OnCall, Some(CallType::Teams), t(0));
        tl.record(CoreState::OnCall, Some(CallType::Teams), t(30));
        tl.record(CoreState::OnCall, Some(CallType::Zoom), t(60));
        assert_eq!(kinds(&tl), ["call_teams", "call_zoom"]);
    }

    #[test]
    fn call_without_a_known_kind_is_other() {
        let mut tl = Timeline::new();
        tl.on_state(CoreState::OnCall, t(0));
        assert_eq!(kinds(&tl), ["call_other"]);
    }

    #[test]
    fn clock_in_during_a_call_starts_with_on_call() {
        let mut tl = Timeline::new();
        tl.record(CoreState::OnCall, Some(CallType::Zoom), t(0));
        assert_eq!(kinds(&tl), ["call_zoom"]);
        assert_eq!(tl.session_started_at(), Some(t(0)));
    }

    #[test]
    fn day_with_prompt_break_and_away() {
        let mut tl = Timeline::new();
        tl.on_state(CoreState::Active, t(0));
        tl.on_state(
            CoreState::IdlePending {
                shown_at: t(300),
                deadline: t(330),
            },
            t(300),
        );
        tl.on_state(
            CoreState::OnBreak {
                kind: BreakKind::Bio,
            },
            t(310),
        );
        tl.on_state(CoreState::Active, t(900));
        tl.on_state(
            CoreState::Away {
                reason: AwayReason::WorkingAway,
            },
            t(1_000),
        );
        tl.on_state(CoreState::ClockedOut, t(2_000));

        assert_eq!(
            kinds(&tl),
            ["working", "prompt", "bio_break", "working", "away_working"]
        );
        let s = tl.segments();
        assert_eq!((s[1].started_at, s[1].ended_at), (t(300), Some(t(310))));
        assert!(s.iter().all(|seg| seg.ended_at.is_some()));
        assert_eq!(tl.session_started_at(), None);
    }

    #[test]
    fn second_session_keeps_first_and_restarts_session_clock() {
        let mut tl = Timeline::new();
        tl.on_state(CoreState::Active, t(0));
        tl.on_state(CoreState::ClockedOut, t(100));
        tl.on_state(CoreState::Active, t(500));
        assert_eq!(kinds(&tl), ["working", "working"]);
        assert_eq!(tl.session_started_at(), Some(t(500)));
        assert_eq!(tl.segments()[0].ended_at, Some(t(100)));
        let sessions: Vec<_> = tl.segments().iter().map(|s| s.session).collect();
        assert_eq!(sessions, [1, 2]);
    }

    #[test]
    fn repeated_clocked_out_is_harmless() {
        let mut tl = Timeline::new();
        tl.on_state(CoreState::ClockedOut, t(0));
        assert!(tl.segments().is_empty());
        assert_eq!(tl.session_started_at(), None);
    }

    #[test]
    fn views_serialise_camel_case_ms() {
        let mut tl = Timeline::new();
        tl.on_state(
            CoreState::OnBreak {
                kind: BreakKind::Meal,
            },
            t(2),
        );
        let json = serde_json::to_value(tl.views()).unwrap();
        assert_eq!(json[0]["kind"], "meal_break");
        assert_eq!(json[0]["startedAt"], 2_000);
        assert!(json[0]["endedAt"].is_null());
        assert_eq!(json[0]["session"], 1);
    }

    fn at(secs: u64) -> SystemTime {
        t(1_790_000_000 + secs)
    }
    #[test]
    fn a_journaled_day_restores_into_an_empty_timeline() {
        let mut day = Timeline::new();
        day.on_state(CoreState::Active, at(0));
        day.on_state(
            CoreState::OnBreak {
                kind: BreakKind::Meal,
            },
            at(3600),
        );
        day.on_state(CoreState::Active, at(5400));
        day.on_state(CoreState::ClockedOut, at(9000));
        day.on_state(CoreState::Active, at(10_000));
        day.on_state(CoreState::ClockedOut, at(11_000));
        let json = day.to_json();

        let mut after = Timeline::new();
        assert!(after.restore(&json, at(20_000)));
        assert_eq!(after.views(), day.views());
        assert_eq!(after.session_started_at(), None);
        // The next clock-in is the day's third session.
        after.on_state(CoreState::Active, at(30_000));
        assert_eq!(after.segments().last().unwrap().session, 3);
    }

    #[test]
    fn an_open_segment_left_by_a_crash_closes_at_the_heartbeat() {
        let mut day = Timeline::new();
        day.on_state(CoreState::Active, at(0));
        let json = day.to_json(); // crash while clocked in

        let mut after = Timeline::new();
        assert!(after.restore(&json, at(1800)));
        assert_eq!(after.segments()[0].ended_at, Some(at(1800)));
        // Never before it started.
        let mut early = Timeline::new();
        early.restore(&json, at(0) - Duration::from_secs(60));
        assert_eq!(early.segments()[0].ended_at, Some(at(0)));
    }

    #[test]
    fn restore_never_overwrites_a_live_day_or_takes_junk() {
        let mut live = Timeline::new();
        live.on_state(CoreState::Active, at(0));
        let json = live.to_json();
        assert!(!live.restore(&json, at(10)));
        let mut empty = Timeline::new();
        assert!(!empty.restore("not json", at(10)));
        assert!(!empty.restore(
            r#"[{"kind":"nope","startedAt":1,"endedAt":2,"session":1}]"#,
            at(10)
        ));
        assert!(empty.segments().is_empty());
    }

    #[test]
    fn every_kind_round_trips_through_its_wire_name() {
        for k in SegmentKind::ALL {
            assert_eq!(SegmentKind::from_wire(k.as_str()), Some(k));
        }
    }

    #[test]
    fn any_since_sees_open_and_later_segments_only() {
        let mut tl = Timeline::new();
        assert!(!tl.any_since(at(0)));
        tl.on_state(CoreState::Active, at(100));
        assert!(tl.any_since(at(5000)), "open segment");
        tl.on_state(CoreState::ClockedOut, at(200));
        assert!(tl.any_since(at(150)));
        assert!(!tl.any_since(at(300)), "ended before");
    }
}
