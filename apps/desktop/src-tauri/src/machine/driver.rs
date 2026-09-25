//! Couples a [`Core`] to an [`EventSink`].
//!
//! [`Driver::handle`] runs an input through the core, records each
//! emitted event in order, and hands back only the effects the UI has
//! to act on (prompt show/hide/update, state changes).
//!
//! Sink failures never lose or reorder events. An event the sink
//! refuses stays at the head of an ordered backlog together with
//! everything emitted after it, and the backlog is retried before any
//! new event on the next `handle` (the ~1 Hz tick guarantees one) or
//! on an explicit [`Driver::flush`]. The core's state has already
//! moved on; the backlog is what keeps the ledger consistent with it.

use std::collections::VecDeque;
use std::time::SystemTime;

use super::sink::{EventSink, SinkError};
use super::{Core, CoreEvent, CoreState, Effect, Input, Rejected};

/// Result of a successful [`Driver::handle`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// Every non-`Emit` effect, in order.
    pub effects: Vec<Effect>,
    /// Set when the sink refused an event during this call.
    pub sink_error: Option<SinkError>,
    /// Events still waiting to be recorded.
    pub backlog: usize,
}

pub struct Driver<S: EventSink> {
    core: Core,
    sink: S,
    backlog: VecDeque<(CoreEvent, SystemTime)>,
}

impl<S: EventSink> Driver<S> {
    pub fn new(core: Core, sink: S) -> Self {
        Self {
            core,
            sink,
            backlog: VecDeque::new(),
        }
    }

    pub fn state(&self) -> CoreState {
        self.core.state()
    }

    pub fn core(&self) -> &Core {
        &self.core
    }

    pub fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }

    pub fn backlog_len(&self) -> usize {
        self.backlog.len()
    }

    /// Rejected inputs change nothing and record nothing; the backlog
    /// is not retried for them.
    pub fn handle(&mut self, input: Input, now: SystemTime) -> Result<Outcome, Rejected> {
        let fx = self.core.handle(input, now)?;
        let mut effects = Vec::with_capacity(fx.len());
        for effect in fx {
            match effect {
                Effect::Emit { event, at } => self.backlog.push_back((event, at)),
                other => effects.push(other),
            }
        }
        let sink_error = self.flush().err();
        Ok(Outcome {
            effects,
            sink_error,
            backlog: self.backlog.len(),
        })
    }

    /// Record backlogged events in order, stopping at the first
    /// failure.
    pub fn flush(&mut self) -> Result<(), SinkError> {
        while let Some((event, at)) = self.backlog.front() {
            self.sink.record(event, *at)?;
            self.backlog.pop_front();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::super::sink::RecordingSink;
    use super::super::{BreakKind, CallType, CoreConfig};
    use super::*;

    fn t(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_790_000_000 + secs)
    }

    /// Sink that fails while `down` is set, otherwise records.
    struct Flaky {
        down: bool,
        inner: RecordingSink,
    }

    impl EventSink for Flaky {
        fn record(&mut self, event: &CoreEvent, at: SystemTime) -> Result<(), SinkError> {
            if self.down {
                return Err(SinkError("down".into()));
            }
            self.inner.record(event, at)
        }
    }

    fn driver_with(sink: RecordingSink) -> Driver<RecordingSink> {
        Driver::new(Core::new(CoreConfig::default(), t(0)), sink)
    }

    #[test]
    fn records_emits_in_order_and_returns_only_ui_effects() {
        let sink = RecordingSink::new();
        let mut d = driver_with(sink.clone());
        d.handle(Input::MediaInUse(Some(CallType::Teams)), t(0))
            .unwrap();
        let out = d.handle(Input::ClockIn, t(1)).unwrap();

        assert_eq!(sink.event_types(), ["USER_CLOCK_IN", "MEDIA_DEVICE_STATE"]);
        assert!(out
            .effects
            .iter()
            .all(|e| !matches!(e, Effect::Emit { .. })));
        assert_eq!(
            out.effects,
            [
                Effect::StateChanged(CoreState::Active),
                Effect::StateChanged(CoreState::OnCall)
            ]
        );
        assert_eq!(out.sink_error, None);
        assert_eq!(out.backlog, 0);
    }

    #[test]
    fn prompt_effects_pass_through() {
        let mut d = driver_with(RecordingSink::new());
        d.handle(Input::ClockIn, t(0)).unwrap();
        let out = d
            .handle(
                Input::Tick {
                    last_input_at: t(0),
                },
                t(300),
            )
            .unwrap();
        assert!(out
            .effects
            .contains(&Effect::ShowPrompt { deadline: t(330) }));
    }

    #[test]
    fn rejected_input_records_nothing() {
        let sink = RecordingSink::new();
        let mut d = driver_with(sink.clone());
        assert_eq!(
            d.handle(Input::EndBreak, t(0)),
            Err(Rejected::InvalidTransition)
        );
        assert!(sink.events().is_empty());
    }

    #[test]
    fn sink_failure_backlogs_then_replays_in_order() {
        let recorded = RecordingSink::new();
        let flaky = Flaky {
            down: true,
            inner: recorded.clone(),
        };
        let mut d = Driver::new(Core::new(CoreConfig::default(), t(0)), flaky);

        let out = d.handle(Input::ClockIn, t(0)).unwrap();
        assert_eq!(out.sink_error, Some(SinkError("down".into())));
        assert_eq!(out.backlog, 1);
        // The core moved on regardless.
        assert_eq!(d.state(), CoreState::Active);

        let out = d.handle(Input::StartBreak(BreakKind::Bio), t(10)).unwrap();
        assert_eq!(out.backlog, 2);
        assert!(recorded.events().is_empty());

        d.sink.down = false;
        let out = d.handle(Input::EndBreak, t(20)).unwrap();
        assert_eq!(out.sink_error, None);
        assert_eq!(out.backlog, 0);
        assert_eq!(
            recorded.event_types(),
            ["USER_CLOCK_IN", "USER_START_BREAK", "USER_END_BREAK"]
        );
        // Original timestamps are kept.
        assert_eq!(recorded.events()[0].1, t(0));
    }

    #[test]
    fn explicit_flush_drains_backlog() {
        let recorded = RecordingSink::new();
        let flaky = Flaky {
            down: true,
            inner: recorded.clone(),
        };
        let mut d = Driver::new(Core::new(CoreConfig::default(), t(0)), flaky);
        d.handle(Input::ClockIn, t(0)).unwrap();
        assert!(d.flush().is_err());
        assert_eq!(d.backlog_len(), 1);

        d.sink.down = false;
        assert_eq!(d.flush(), Ok(()));
        assert_eq!(d.backlog_len(), 0);
        assert_eq!(recorded.event_types(), ["USER_CLOCK_IN"]);
    }

    #[test]
    fn permanently_failing_sink_keeps_everything() {
        let mut d = driver_with(RecordingSink::failing("gone"));
        d.handle(Input::ClockIn, t(0)).unwrap();
        d.handle(Input::ClockOut, t(5)).unwrap();
        assert_eq!(d.backlog_len(), 2);
    }
}
