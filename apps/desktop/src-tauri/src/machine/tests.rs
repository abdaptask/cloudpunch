use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::*;

/// The policy these tests were written against: a 300 s threshold.
/// The shipped default is 120 s (ADR-0018 §3; see `default_prompt_*`).
fn cfg() -> CoreConfig {
    CoreConfig {
        idle_threshold: Duration::from_secs(300),
        ..CoreConfig::default()
    }
}

fn t(secs: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_790_000_000 + secs)
}

fn emitted(fx: &[Effect]) -> Vec<&'static str> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Emit { event, .. } => Some(event.event_type()),
            _ => None,
        })
        .collect()
}

/// Core clocked in at t(0) with default policy (300 s / 30 s / 5 s).
fn clocked_in() -> Core {
    let mut core = Core::new(cfg(), t(0));
    core.handle(Input::ClockIn, t(0)).unwrap();
    core
}

fn tick(core: &mut Core, last_input: u64, now: u64) -> Vec<Effect> {
    core.handle(
        Input::Tick {
            last_input_at: t(last_input),
        },
        t(now),
    )
    .unwrap()
}

/// Clocked in, no input since t(0), prompt shown at t(300).
fn prompting() -> Core {
    let mut core = clocked_in();
    tick(&mut core, 0, 300);
    assert!(matches!(core.state(), CoreState::IdlePending { .. }));
    core
}

fn respond(
    core: &mut Core,
    response: PromptResponse,
    note: Option<&str>,
) -> Result<Vec<Effect>, Rejected> {
    core.handle(
        Input::RespondToPrompt {
            response,
            note: note.map(str::to_string),
        },
        t(310),
    )
}

// ── clock in / out ────────────────────────────────────────────────

#[test]
fn clock_in_emits_and_enters_active() {
    let mut core = Core::new(cfg(), t(0));
    let fx = core.handle(Input::ClockIn, t(0)).unwrap();
    assert_eq!(emitted(&fx), ["USER_CLOCK_IN"]);
    assert_eq!(core.state(), CoreState::Active);
    assert!(fx.contains(&Effect::StateChanged(CoreState::Active)));
}

#[test]
fn clock_in_twice_is_rejected_without_effects() {
    let mut core = clocked_in();
    assert_eq!(
        core.handle(Input::ClockIn, t(1)),
        Err(Rejected::InvalidTransition)
    );
    assert_eq!(core.state(), CoreState::Active);
}

#[test]
fn clock_in_during_a_call_goes_straight_to_on_call() {
    let mut core = Core::new(cfg(), t(0));
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(0))
        .unwrap();
    let fx = core.handle(Input::ClockIn, t(1)).unwrap();
    assert_eq!(emitted(&fx), ["USER_CLOCK_IN", "MEDIA_DEVICE_STATE"]);
    assert_eq!(core.state(), CoreState::OnCall);
}

#[test]
fn clock_out_from_each_open_state() {
    let mut active = clocked_in();
    let mut on_call = clocked_in();
    on_call
        .handle(Input::MediaInUse(Some(CallType::Teams)), t(1))
        .unwrap();
    let mut on_break = clocked_in();
    on_break
        .handle(
            Input::StartBreak {
                kind: BreakKind::Bio,
                planned_minutes: None,
            },
            t(1),
        )
        .unwrap();
    let mut away = prompting();
    respond(&mut away, PromptResponse::OnPhoneCall, None).unwrap();
    let mut pending = prompting();

    for core in [
        &mut active,
        &mut on_call,
        &mut on_break,
        &mut away,
        &mut pending,
    ] {
        let fx = core.handle(Input::ClockOut, t(400)).unwrap();
        assert_eq!(emitted(&fx), ["USER_CLOCK_OUT"]);
        assert_eq!(core.state(), CoreState::ClockedOut);
    }
}

#[test]
fn clock_out_while_prompting_hides_the_prompt() {
    let mut core = prompting();
    let fx = core.handle(Input::ClockOut, t(305)).unwrap();
    assert!(fx.contains(&Effect::HidePrompt));
}

#[test]
fn clock_out_when_clocked_out_is_rejected() {
    let mut core = Core::new(cfg(), t(0));
    assert_eq!(
        core.handle(Input::ClockOut, t(0)),
        Err(Rejected::InvalidTransition)
    );
}

// ── breaks and away ───────────────────────────────────────────────

#[test]
fn break_round_trip_re_arms_idle_timer() {
    let mut core = clocked_in();
    let fx = core
        .handle(
            Input::StartBreak {
                kind: BreakKind::Meal,
                planned_minutes: None,
            },
            t(100),
        )
        .unwrap();
    assert_eq!(emitted(&fx), ["USER_START_BREAK"]);
    assert_eq!(
        core.state(),
        CoreState::OnBreak {
            kind: BreakKind::Meal
        }
    );

    // No prompt while on break, however long.
    assert!(emitted(&tick(&mut core, 0, 3_000)).is_empty());

    core.handle(Input::EndBreak, t(3_600)).unwrap();
    assert_eq!(core.state(), CoreState::Active);
    // Threshold runs from the end of the break, not from last input.
    assert!(emitted(&tick(&mut core, 0, 3_899)).is_empty());
    assert_eq!(emitted(&tick(&mut core, 0, 3_900)), ["INPUT_IDLE_5M"]);
}

#[test]
fn break_start_payload_carries_kind() {
    let mut core = clocked_in();
    let fx = core
        .handle(
            Input::StartBreak {
                kind: BreakKind::Bio,
                planned_minutes: None,
            },
            t(1),
        )
        .unwrap();
    let Some(Effect::Emit { event, .. }) = fx.first() else {
        panic!("expected an emit first");
    };
    assert_eq!(event.transition_payload(), json!({ "break_kind": "bio" }));
}

#[test]
fn end_break_when_active_is_rejected() {
    let mut core = clocked_in();
    assert_eq!(
        core.handle(Input::EndBreak, t(1)),
        Err(Rejected::InvalidTransition)
    );
}

#[test]
fn mark_back_from_away_returns_to_active() {
    let mut core = prompting();
    respond(&mut core, PromptResponse::WorkingAway, Some("site visit")).unwrap();
    let fx = core.handle(Input::MarkBack, t(900)).unwrap();
    assert_eq!(emitted(&fx), ["USER_MARK_BACK"]);
    assert_eq!(core.state(), CoreState::Active);
}

#[test]
fn mark_back_when_active_is_rejected() {
    let mut core = clocked_in();
    assert_eq!(
        core.handle(Input::MarkBack, t(1)),
        Err(Rejected::InvalidTransition)
    );
}

// ── idle threshold ────────────────────────────────────────────────

#[test]
fn prompt_fires_at_threshold_not_before() {
    let mut core = clocked_in();
    assert!(emitted(&tick(&mut core, 0, 299)).is_empty());
    let fx = tick(&mut core, 0, 300);
    assert_eq!(emitted(&fx), ["INPUT_IDLE_5M"]);
    assert!(fx.contains(&Effect::ShowPrompt { deadline: t(330) }));
    assert_eq!(
        core.state(),
        CoreState::IdlePending {
            shown_at: t(300),
            deadline: t(330),
            idle_since: t(0)
        }
    );
}

#[test]
fn input_before_threshold_resets_it() {
    let mut core = clocked_in();
    assert!(emitted(&tick(&mut core, 200, 450)).is_empty());
    assert_eq!(emitted(&tick(&mut core, 200, 500)), ["INPUT_IDLE_5M"]);
}

#[test]
fn future_last_input_is_treated_as_now() {
    let mut core = clocked_in();
    assert!(emitted(&tick(&mut core, 10_000, 400)).is_empty());
    assert_eq!(core.state(), CoreState::Active);
}

// ── grace countdown (ADR-0008) ────────────────────────────────────

#[test]
fn timeout_without_input_logs_idle_from_the_last_input() {
    // ADR-0018 §1: no clock-out; idle counted from the last input.
    let mut core = prompting();
    assert!(emitted(&tick(&mut core, 0, 329)).is_empty());
    let fx = tick(&mut core, 0, 330);
    assert_eq!(emitted(&fx), ["IDLE_STARTED"]);
    assert!(fx.contains(&Effect::HidePrompt));
    assert_eq!(core.state(), CoreState::Idle { since: t(0) });
}

#[test]
fn input_during_prompt_pushes_deadline_but_keeps_prompt() {
    let mut core = prompting();
    let fx = tick(&mut core, 320, 321);
    assert!(emitted(&fx).is_empty());
    assert!(fx.contains(&Effect::UpdatePromptDeadline { deadline: t(350) }));
    assert!(matches!(core.state(), CoreState::IdlePending { deadline, .. } if deadline == t(350)));

    // Old deadline passes; still pending.
    assert!(emitted(&tick(&mut core, 320, 340)).is_empty());
    // New deadline passes with no further input: idle since that input.
    assert_eq!(emitted(&tick(&mut core, 320, 350)), ["IDLE_STARTED"]);
    assert_eq!(core.state(), CoreState::Idle { since: t(320) });
}

#[test]
fn continuous_input_keeps_prompt_up_indefinitely() {
    let mut core = prompting();
    for s in 301..=600 {
        assert!(
            emitted(&tick(&mut core, s, s)).is_empty(),
            "timed out at {s}"
        );
    }
    assert!(matches!(core.state(), CoreState::IdlePending { .. }));
}

#[test]
fn deadline_update_only_when_it_moves() {
    let mut core = prompting();
    tick(&mut core, 320, 321);
    let fx = tick(&mut core, 320, 322);
    assert!(!fx
        .iter()
        .any(|e| matches!(e, Effect::UpdatePromptDeadline { .. })));
}

#[test]
fn input_from_before_the_prompt_does_not_extend_it() {
    let mut core = prompting();
    let fx = tick(&mut core, 299, 310);
    assert!(!fx
        .iter()
        .any(|e| matches!(e, Effect::UpdatePromptDeadline { .. })));
}

// ── prompt responses ──────────────────────────────────────────────

#[test]
fn each_response_lands_in_the_right_state() {
    let cases = [
        (PromptResponse::StillWorking, None, CoreState::Active),
        (
            PromptResponse::BioBreak,
            None,
            CoreState::OnBreak {
                kind: BreakKind::Bio,
            },
        ),
        (
            PromptResponse::MealBreak,
            None,
            CoreState::OnBreak {
                kind: BreakKind::Meal,
            },
        ),
        (
            PromptResponse::OnPhoneCall,
            None,
            CoreState::Away {
                reason: AwayReason::PhoneCall,
            },
        ),
        (
            PromptResponse::WorkingAway,
            Some("client site"),
            CoreState::Away {
                reason: AwayReason::WorkingAway,
            },
        ),
        (PromptResponse::EndShift, None, CoreState::ClockedOut),
    ];
    for (response, note, expected) in cases {
        let mut core = prompting();
        let fx = respond(&mut core, response, note).unwrap();
        assert_eq!(emitted(&fx), ["USER_PROMPT_RESPONSE"], "{response:?}");
        assert!(fx.contains(&Effect::HidePrompt), "{response:?}");
        assert_eq!(core.state(), expected, "{response:?}");
    }
}

#[test]
fn response_event_carries_prompt_shown_at_and_trimmed_note() {
    let mut core = prompting();
    let fx = respond(
        &mut core,
        PromptResponse::WorkingAway,
        Some("  at the bank  "),
    )
    .unwrap();
    let Some(Effect::Emit { event, at }) = fx.first() else {
        panic!("expected an emit first");
    };
    assert_eq!(*at, t(310));
    assert_eq!(
        *event,
        CoreEvent::UserPromptResponse {
            response: PromptResponse::WorkingAway,
            note: Some("at the bank".into()),
            prompt_shown_at: t(300),
        }
    );
}

#[test]
fn still_working_re_arms_idle_timer_from_response() {
    let mut core = prompting();
    respond(&mut core, PromptResponse::StillWorking, None).unwrap();
    assert!(emitted(&tick(&mut core, 305, 609)).is_empty());
    assert_eq!(emitted(&tick(&mut core, 305, 610)), ["INPUT_IDLE_5M"]);
}

#[test]
fn working_away_requires_a_non_blank_note() {
    let mut core = prompting();
    assert_eq!(
        respond(&mut core, PromptResponse::WorkingAway, None),
        Err(Rejected::NoteRequired)
    );
    assert_eq!(
        respond(&mut core, PromptResponse::WorkingAway, Some("   ")),
        Err(Rejected::NoteRequired)
    );
    assert!(matches!(core.state(), CoreState::IdlePending { .. }));
}

#[test]
fn note_over_500_chars_is_rejected() {
    let mut core = prompting();
    let long = "é".repeat(NOTE_MAX_CHARS + 1);
    assert_eq!(
        respond(&mut core, PromptResponse::OnPhoneCall, Some(&long)),
        Err(Rejected::NoteTooLong)
    );
    let ok = "é".repeat(NOTE_MAX_CHARS);
    assert!(respond(&mut core, PromptResponse::OnPhoneCall, Some(&ok)).is_ok());
}

#[test]
fn response_not_in_policy_options_is_rejected() {
    let cfg = CoreConfig {
        prompt_options: vec![PromptResponse::StillWorking, PromptResponse::EndShift],
        ..cfg()
    };
    let mut core = Core::new(cfg, t(0));
    core.handle(Input::ClockIn, t(0)).unwrap();
    tick(&mut core, 0, 300);
    assert_eq!(
        respond(&mut core, PromptResponse::BioBreak, None),
        Err(Rejected::OptionNotOffered)
    );
}

#[test]
fn response_without_a_prompt_is_rejected() {
    let mut core = clocked_in();
    assert_eq!(
        respond(&mut core, PromptResponse::StillWorking, None),
        Err(Rejected::InvalidTransition)
    );
}

// ── media / ON_CALL (ADR-0009) ────────────────────────────────────

#[test]
fn call_start_enters_on_call_immediately() {
    let mut core = clocked_in();
    let fx = core
        .handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    assert_eq!(emitted(&fx), ["MEDIA_DEVICE_STATE"]);
    let Some(Effect::Emit { event, .. }) = fx.first() else {
        panic!("expected an emit first");
    };
    assert_eq!(
        event.transition_payload(),
        json!({ "in_use": true, "call_type": "teams" })
    );
    assert_eq!(core.state(), CoreState::OnCall);
}

#[test]
fn no_idle_prompt_during_a_call_before_the_cap() {
    let mut core = clocked_in();
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    // Well past the 300 s idle threshold, short of the 30 min cap.
    assert!(emitted(&tick(&mut core, 0, 1_809)).is_empty());
    assert_eq!(core.state(), CoreState::OnCall);
}

// ── silent-call cap (ADR-0010) ────────────────────────────────────

fn idle_trigger(fx: &[Effect]) -> Option<IdleTrigger> {
    fx.iter().find_map(|e| match e {
        Effect::Emit {
            event: CoreEvent::InputIdle5m { trigger },
            ..
        } => Some(*trigger),
        _ => None,
    })
}

/// Clocked in at t(0); call from t(10); no input since t(0).
fn on_call() -> Core {
    let mut core = clocked_in();
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    core
}

#[test]
fn silent_call_prompts_at_cap_measured_from_call_start() {
    let mut core = on_call();
    assert!(emitted(&tick(&mut core, 0, 1_809)).is_empty());
    let fx = tick(&mut core, 0, 1_810);
    assert_eq!(idle_trigger(&fx), Some(IdleTrigger::SilentCall));
    assert!(fx.contains(&Effect::ShowPrompt { deadline: t(1_840) }));
    assert!(matches!(core.state(), CoreState::IdlePending { .. }));
}

#[test]
fn silent_call_payload_carries_trigger() {
    let mut core = on_call();
    let fx = tick(&mut core, 0, 1_810);
    let Some(Effect::Emit { event, .. }) = fx.first() else {
        panic!("expected an emit first");
    };
    assert_eq!(
        event.transition_payload(),
        json!({ "trigger": "silent_call" })
    );
}

#[test]
fn input_during_call_resets_the_cap() {
    let mut core = on_call();
    assert!(emitted(&tick(&mut core, 1_000, 1_810)).is_empty());
    assert!(emitted(&tick(&mut core, 1_000, 2_799)).is_empty());
    assert_eq!(
        idle_trigger(&tick(&mut core, 1_000, 2_800)),
        Some(IdleTrigger::SilentCall)
    );
}

#[test]
fn ongoing_call_does_not_dismiss_the_silent_call_prompt() {
    let mut core = on_call();
    tick(&mut core, 0, 1_810);
    // Watcher re-reports the same state: no edge, prompt stays.
    let fx = core
        .handle(Input::MediaInUse(Some(CallType::Teams)), t(1_815))
        .unwrap();
    assert!(emitted(&fx).is_empty());
    assert!(matches!(core.state(), CoreState::IdlePending { .. }));
}

#[test]
fn call_ending_during_silent_call_prompt_keeps_prompt() {
    let mut core = on_call();
    tick(&mut core, 0, 1_810);
    core.handle(Input::MediaInUse(None), t(1_812)).unwrap();
    // Debounce elapses inside the grace window; ADR-0009 records
    // nothing from IDLE_PENDING on in_use=false.
    let fx = tick(&mut core, 0, 1_820);
    assert!(emitted(&fx).is_empty());
    assert!(matches!(core.state(), CoreState::IdlePending { .. }));
}

#[test]
fn still_working_returns_to_call_and_restarts_cap() {
    let mut core = on_call();
    tick(&mut core, 0, 1_810);
    let fx = core
        .handle(
            Input::RespondToPrompt {
                response: PromptResponse::StillWorking,
                note: None,
            },
            t(1_815),
        )
        .unwrap();
    assert_eq!(emitted(&fx), ["USER_PROMPT_RESPONSE", "MEDIA_DEVICE_STATE"]);
    assert_eq!(core.state(), CoreState::OnCall);
    assert!(emitted(&tick(&mut core, 0, 3_614)).is_empty());
    assert_eq!(
        idle_trigger(&tick(&mut core, 0, 3_615)),
        Some(IdleTrigger::SilentCall)
    );
}

#[test]
fn silent_call_prompt_times_out_to_idle() {
    let mut core = on_call();
    tick(&mut core, 0, 1_810);
    assert_eq!(emitted(&tick(&mut core, 0, 1_840)), ["IDLE_STARTED"]);
    // Idle from when the call went silent (the call started at t(10)).
    assert_eq!(core.state(), CoreState::Idle { since: t(10) });
}

#[test]
fn cap_disabled_means_calls_never_prompt() {
    let cfg = CoreConfig {
        max_silent_call: None,
        ..cfg()
    };
    let mut core = Core::new(cfg, t(0));
    core.handle(Input::ClockIn, t(0)).unwrap();
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    assert!(emitted(&tick(&mut core, 0, 100_000)).is_empty());
    assert_eq!(core.state(), CoreState::OnCall);
}

#[test]
fn normal_idle_prompt_is_input_idle() {
    let mut core = clocked_in();
    assert_eq!(
        idle_trigger(&tick(&mut core, 0, 300)),
        Some(IdleTrigger::InputIdle)
    );
}

#[test]
fn call_end_is_debounced_then_re_arms_idle_timer() {
    let mut core = clocked_in();
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    core.handle(Input::MediaInUse(None), t(1_000)).unwrap();
    assert!(emitted(&tick(&mut core, 0, 1_004)).is_empty());
    assert_eq!(core.state(), CoreState::OnCall);

    let fx = tick(&mut core, 0, 1_005);
    assert_eq!(emitted(&fx), ["MEDIA_DEVICE_STATE"]);
    assert_eq!(core.state(), CoreState::Active);

    // Idle threshold runs from the call ending.
    assert!(emitted(&tick(&mut core, 0, 1_304)).is_empty());
    assert_eq!(emitted(&tick(&mut core, 0, 1_305)), ["INPUT_IDLE_5M"]);
}

#[test]
fn media_blip_inside_debounce_keeps_the_call() {
    let mut core = clocked_in();
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    core.handle(Input::MediaInUse(None), t(100)).unwrap();
    let fx = core
        .handle(Input::MediaInUse(Some(CallType::Teams)), t(103))
        .unwrap();
    assert!(emitted(&fx).is_empty());
    assert!(emitted(&tick(&mut core, 0, 200)).is_empty());
    assert_eq!(core.state(), CoreState::OnCall);
}

#[test]
fn call_start_dismisses_the_prompt() {
    let mut core = prompting();
    let fx = core
        .handle(Input::MediaInUse(Some(CallType::Teams)), t(310))
        .unwrap();
    assert_eq!(emitted(&fx), ["MEDIA_DEVICE_STATE"]);
    assert!(fx.contains(&Effect::HidePrompt));
    assert_eq!(core.state(), CoreState::OnCall);
}

#[test]
fn call_during_break_is_not_recorded_until_break_ends() {
    let mut core = clocked_in();
    core.handle(
        Input::StartBreak {
            kind: BreakKind::Bio,
            planned_minutes: None,
        },
        t(10),
    )
    .unwrap();
    let fx = core
        .handle(Input::MediaInUse(Some(CallType::Teams)), t(20))
        .unwrap();
    assert!(emitted(&fx).is_empty());
    assert_eq!(
        core.state(),
        CoreState::OnBreak {
            kind: BreakKind::Bio
        }
    );

    let fx = core.handle(Input::EndBreak, t(30)).unwrap();
    assert_eq!(emitted(&fx), ["USER_END_BREAK", "MEDIA_DEVICE_STATE"]);
    assert_eq!(core.state(), CoreState::OnCall);
}

#[test]
fn call_ending_during_break_leaves_active_on_return() {
    let mut core = clocked_in();
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    core.handle(
        Input::StartBreak {
            kind: BreakKind::Bio,
            planned_minutes: None,
        },
        t(20),
    )
    .unwrap();
    core.handle(Input::MediaInUse(None), t(30)).unwrap();
    assert!(emitted(&tick(&mut core, 0, 40)).is_empty());
    let fx = core.handle(Input::EndBreak, t(50)).unwrap();
    assert_eq!(emitted(&fx), ["USER_END_BREAK"]);
    assert_eq!(core.state(), CoreState::Active);
}

#[test]
fn media_ignored_when_suppression_disabled() {
    let cfg = CoreConfig {
        suppress_prompt_when_media_active: false,
        ..cfg()
    };
    let mut core = Core::new(cfg, t(0));
    core.handle(Input::ClockIn, t(0)).unwrap();
    assert!(emitted(
        &core
            .handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
            .unwrap()
    )
    .is_empty());
    assert_eq!(emitted(&tick(&mut core, 0, 300)), ["INPUT_IDLE_5M"]);
}

#[test]
fn media_while_clocked_out_emits_nothing() {
    let mut core = Core::new(cfg(), t(0));
    assert!(emitted(
        &core
            .handle(Input::MediaInUse(Some(CallType::Teams)), t(1))
            .unwrap()
    )
    .is_empty());
    assert_eq!(core.state(), CoreState::ClockedOut);
}

#[test]
fn start_break_from_on_call_is_allowed() {
    let mut core = clocked_in();
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    core.handle(
        Input::StartBreak {
            kind: BreakKind::Other,
            planned_minutes: None,
        },
        t(20),
    )
    .unwrap();
    assert_eq!(
        core.state(),
        CoreState::OnBreak {
            kind: BreakKind::Other
        }
    );
}

// ── parity with the server machine ────────────────────────────────

/// Replays every event a scripted day emits through the wire-level
/// mirror, proving the core never records a transition the backend
/// would reject.
#[test]
fn emitted_stream_is_accepted_by_server_machine() {
    let mut core = Core::new(cfg(), t(0));
    let mut all = Vec::new();
    let mut run = |core: &mut Core, input: Input, now: u64| {
        all.extend(core.handle(input, t(now)).unwrap());
    };
    run(&mut core, Input::ClockIn, 0);
    run(&mut core, Input::MediaInUse(Some(CallType::Teams)), 60);
    run(&mut core, Input::MediaInUse(None), 1_800);
    run(
        &mut core,
        Input::Tick {
            last_input_at: t(0),
        },
        1_805,
    );
    run(
        &mut core,
        Input::Tick {
            last_input_at: t(0),
        },
        2_105,
    );
    run(
        &mut core,
        Input::RespondToPrompt {
            response: PromptResponse::BioBreak,
            note: None,
        },
        2_110,
    );
    run(&mut core, Input::EndBreak, 2_500);
    run(
        &mut core,
        Input::Tick {
            last_input_at: t(2_500),
        },
        2_800,
    );
    run(&mut core, Input::MediaInUse(Some(CallType::Teams)), 2_810);
    run(
        &mut core,
        Input::StartBreak {
            kind: BreakKind::Meal,
            planned_minutes: None,
        },
        3_000,
    );
    run(&mut core, Input::EndBreak, 6_000);
    run(&mut core, Input::ClockOut, 9_000);

    let events: Vec<&CoreEvent> = all
        .iter()
        .filter_map(|e| match e {
            Effect::Emit { event, .. } => Some(event),
            _ => None,
        })
        .collect();
    assert_eq!(events.first(), Some(&&CoreEvent::UserClockIn));

    let mut state = PayrollState::Active;
    for event in &events[1..] {
        let payload = event.transition_payload();
        state = transitions::next_payroll_state(state, event.event_type(), Some(&payload))
            .unwrap_or_else(|| panic!("server would reject {event:?} from {state:?}"));
    }
    assert_eq!(state, PayrollState::Closed);
}

// ── voluntary away tags (ADR-0011 §2) ─────────────────────────────

fn mark_away(
    core: &mut Core,
    reason: AwayReason,
    note: Option<&str>,
) -> Result<Vec<Effect>, Rejected> {
    core.handle(
        Input::MarkAway {
            reason,
            note: note.map(str::to_string),
        },
        t(100),
    )
}

#[test]
fn meeting_tag_enters_away_meeting_with_reason_payload() {
    let mut core = clocked_in();
    let fx = mark_away(&mut core, AwayReason::Meeting, None).unwrap();
    assert_eq!(emitted(&fx), ["USER_MARK_AWAY"]);
    let Some(Effect::Emit { event, .. }) = fx.first() else {
        panic!("expected an emit first");
    };
    assert_eq!(
        event.transition_payload(),
        json!({ "away_reason": "meeting" })
    );
    assert_eq!(
        core.state(),
        CoreState::Away {
            reason: AwayReason::Meeting
        }
    );
}

#[test]
fn phone_call_tag_needs_no_note() {
    let mut core = clocked_in();
    mark_away(&mut core, AwayReason::PhoneCall, Some("  ")).unwrap();
    assert_eq!(
        core.state(),
        CoreState::Away {
            reason: AwayReason::PhoneCall
        }
    );
}

#[test]
fn working_away_tag_requires_a_note() {
    let mut core = clocked_in();
    assert_eq!(
        mark_away(&mut core, AwayReason::WorkingAway, None),
        Err(Rejected::NoteRequired)
    );
    assert_eq!(core.state(), CoreState::Active);
    assert!(mark_away(&mut core, AwayReason::WorkingAway, Some("site visit")).is_ok());
}

#[test]
fn away_tag_note_is_capped() {
    let mut core = clocked_in();
    let long = "x".repeat(NOTE_MAX_CHARS + 1);
    assert_eq!(
        mark_away(&mut core, AwayReason::Meeting, Some(&long)),
        Err(Rejected::NoteTooLong)
    );
}

#[test]
fn no_idle_prompt_while_tagged_away_and_back_returns_active() {
    let mut core = clocked_in();
    mark_away(&mut core, AwayReason::Meeting, None).unwrap();
    // No cap on voluntary away (ADR-0011 §4).
    assert!(emitted(&tick(&mut core, 0, 20_000)).is_empty());
    core.handle(Input::MarkBack, t(20_001)).unwrap();
    assert_eq!(core.state(), CoreState::Active);
}

#[test]
fn away_tags_are_rejected_during_a_call_and_on_break() {
    let mut on_call = on_call();
    assert_eq!(
        mark_away(&mut on_call, AwayReason::Meeting, None),
        Err(Rejected::InvalidTransition)
    );
    let mut on_break = clocked_in();
    on_break
        .handle(
            Input::StartBreak {
                kind: BreakKind::Bio,
                planned_minutes: None,
            },
            t(10),
        )
        .unwrap();
    assert_eq!(
        mark_away(&mut on_break, AwayReason::PhoneCall, None),
        Err(Rejected::InvalidTransition)
    );
}

// ── call type (ADR-0012) ──────────────────────────────────────────

fn media_payloads(fx: &[Effect]) -> Vec<Value> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Emit {
                event: event @ CoreEvent::MediaDeviceState { .. },
                ..
            } => Some(event.transition_payload()),
            _ => None,
        })
        .collect()
}

#[test]
fn call_start_records_the_call_type() {
    let mut core = clocked_in();
    let fx = core
        .handle(Input::MediaInUse(Some(CallType::Zoom)), t(10))
        .unwrap();
    assert_eq!(
        media_payloads(&fx),
        [json!({ "in_use": true, "call_type": "zoom" })]
    );
    assert_eq!(core.call_type(), Some(CallType::Zoom));
}

#[test]
fn switching_app_mid_call_records_the_new_type_and_stays_on_call() {
    let mut core = clocked_in();
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    let fx = core
        .handle(Input::MediaInUse(Some(CallType::Zoom)), t(20))
        .unwrap();
    assert_eq!(
        media_payloads(&fx),
        [json!({ "in_use": true, "call_type": "zoom" })]
    );
    assert_eq!(core.state(), CoreState::OnCall);
    assert_eq!(core.call_type(), Some(CallType::Zoom));
    // Same type again: nothing new recorded.
    let fx = core
        .handle(Input::MediaInUse(Some(CallType::Zoom)), t(22))
        .unwrap();
    assert!(emitted(&fx).is_empty());
}

#[test]
fn call_end_payload_has_no_call_type() {
    let mut core = clocked_in();
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    core.handle(Input::MediaInUse(None), t(100)).unwrap();
    let fx = tick(&mut core, 0, 105);
    assert_eq!(media_payloads(&fx), [json!({ "in_use": false })]);
    assert_eq!(core.call_type(), None);
}

#[test]
fn call_type_is_none_unless_on_call() {
    let mut core = clocked_in();
    core.handle(
        Input::StartBreak {
            kind: BreakKind::Bio,
            planned_minutes: None,
        },
        t(5),
    )
    .unwrap();
    core.handle(Input::MediaInUse(Some(CallType::Teams)), t(10))
        .unwrap();
    assert_eq!(core.call_type(), None);
    let fx = core.handle(Input::EndBreak, t(20)).unwrap();
    assert_eq!(
        media_payloads(&fx),
        [json!({ "in_use": true, "call_type": "teams" })]
    );
    assert_eq!(core.call_type(), Some(CallType::Teams));
}

// ── ADR-0018: logged idle ────────────────────────────────────────────

/// When `event_type` was emitted in `fx`.
fn emitted_at(fx: &[Effect], event_type: &str) -> Option<SystemTime> {
    fx.iter().find_map(|e| match e {
        Effect::Emit { event, at } if event.event_type() == event_type => Some(*at),
        _ => None,
    })
}

/// Prompted at t(300), unanswered: idle since t(0) from t(330).
fn idle() -> Core {
    let mut core = prompting();
    tick(&mut core, 0, 330);
    assert_eq!(core.state(), CoreState::Idle { since: t(0) });
    core
}

#[test]
fn default_prompt_is_after_two_minutes() {
    let mut core = Core::new(CoreConfig::default(), t(0));
    core.handle(Input::ClockIn, t(0)).unwrap();
    assert!(emitted(&tick(&mut core, 0, 119)).is_empty());
    assert_eq!(emitted(&tick(&mut core, 0, 120)), ["INPUT_IDLE_5M"]);
}

#[test]
fn idle_starts_at_the_last_input_before_the_prompt() {
    let mut core = clocked_in();
    tick(&mut core, 100, 400);
    assert!(
        matches!(core.state(), CoreState::IdlePending { idle_since, .. } if idle_since == t(100))
    );
    let fx = tick(&mut core, 100, 430);
    assert_eq!(emitted(&fx), ["IDLE_STARTED"]);
    assert_eq!(core.state(), CoreState::Idle { since: t(100) });
}

#[test]
fn input_after_idle_ends_it_and_asks_what_happened() {
    let mut core = idle();
    assert!(emitted(&tick(&mut core, 0, 900)).is_empty(), "still idle");
    let fx = tick(&mut core, 1_000, 1_001);
    assert_eq!(emitted(&fx), ["IDLE_ENDED"]);
    assert_eq!(emitted_at(&fx, "IDLE_ENDED"), Some(t(1_000)));
    let stretch = IdleStretch {
        since: t(0),
        until: t(1_000),
    };
    assert!(fx.contains(&Effect::IdleReturned(stretch)));
    assert_eq!(core.state(), CoreState::Active);
    assert_eq!(core.idle_return(), Some(stretch));
    // Re-armed from the return: the next prompt is a full threshold later.
    assert!(emitted(&tick(&mut core, 1_000, 1_299)).is_empty());
    assert_eq!(emitted(&tick(&mut core, 1_000, 1_300)), ["INPUT_IDLE_5M"]);
}

#[test]
fn explaining_records_an_annotation_and_changes_nothing_else() {
    let mut core = idle();
    tick(&mut core, 1_000, 1_001);
    let fx = core
        .handle(
            Input::ExplainIdle {
                explanation: IdleExplanation::Meeting,
                note: Some("  standup in room 2 ".into()),
            },
            t(1_010),
        )
        .unwrap();
    assert_eq!(emitted(&fx), ["USER_IDLE_EXPLAINED"]);
    match &fx[0] {
        Effect::Emit {
            event:
                CoreEvent::UserIdleExplained {
                    stretch,
                    explanation,
                    note,
                },
            ..
        } => {
            assert_eq!(stretch.since, t(0));
            assert_eq!(stretch.until, t(1_000));
            assert_eq!(*explanation, IdleExplanation::Meeting);
            assert_eq!(note.as_deref(), Some("standup in room 2"));
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(core.state(), CoreState::Active);
    assert_eq!(core.idle_return(), None);
    // Nothing left to explain.
    assert_eq!(
        core.handle(
            Input::ExplainIdle {
                explanation: IdleExplanation::Idle,
                note: None,
            },
            t(1_020),
        ),
        Err(Rejected::InvalidTransition)
    );
}

#[test]
fn skipping_the_question_leaves_it_unexplained() {
    let mut core = idle();
    tick(&mut core, 1_000, 1_001);
    let fx = core.handle(Input::DismissIdleReturn, t(1_005)).unwrap();
    assert!(emitted(&fx).is_empty());
    assert_eq!(core.idle_return(), None);
}

#[test]
fn the_idle_cap_closes_the_session_when_it_was_reached() {
    let mut core = idle();
    assert!(emitted(&tick(&mut core, 0, 7_199)).is_empty());
    let fx = tick(&mut core, 0, 7_200);
    assert_eq!(emitted(&fx), ["IDLE_CAP_REACHED"]);
    assert_eq!(core.state(), CoreState::ClockedOut);
}

#[test]
fn a_laptop_asleep_past_the_cap_is_dated_at_the_cap() {
    let mut core = idle();
    let fx = tick(&mut core, 0, 30_000);
    assert_eq!(emitted_at(&fx, "IDLE_CAP_REACHED"), Some(t(7_200)));
    assert_eq!(core.state(), CoreState::ClockedOut);
}

#[test]
fn asleep_through_prompt_and_cap() {
    // Active, then the next tick comes hours later (sleep): the prompt
    // opens now, and the cap applies once the grace has passed.
    let mut core = clocked_in();
    assert_eq!(emitted(&tick(&mut core, 0, 20_000)), ["INPUT_IDLE_5M"]);
    let fx = tick(&mut core, 0, 20_030);
    assert_eq!(emitted(&fx), ["IDLE_STARTED", "IDLE_CAP_REACHED"]);
    assert_eq!(emitted_at(&fx, "IDLE_CAP_REACHED"), Some(t(7_200)));
}

#[test]
fn cap_disabled_keeps_logging_idle() {
    let cfg = CoreConfig {
        max_idle: None,
        ..cfg()
    };
    let mut core = Core::new(cfg, t(0));
    core.handle(Input::ClockIn, t(0)).unwrap();
    tick(&mut core, 0, 300);
    tick(&mut core, 0, 330);
    assert!(emitted(&tick(&mut core, 0, 100_000)).is_empty());
    assert_eq!(core.state(), CoreState::Idle { since: t(0) });
}

#[test]
fn a_click_while_idle_ends_idle_first() {
    let mut core = idle();
    let fx = core
        .handle(
            Input::StartBreak {
                kind: BreakKind::Meal,
                planned_minutes: None,
            },
            t(2_000),
        )
        .unwrap();
    assert_eq!(emitted(&fx), ["IDLE_ENDED", "USER_START_BREAK"]);
    assert_eq!(
        core.state(),
        CoreState::OnBreak {
            kind: BreakKind::Meal
        }
    );
}

#[test]
fn clock_out_right_after_idle_drops_the_question() {
    let mut core = idle();
    let fx = core.handle(Input::ClockOut, t(2_000)).unwrap();
    assert_eq!(emitted(&fx), ["IDLE_ENDED", "USER_CLOCK_OUT"]);
    assert_eq!(core.state(), CoreState::ClockedOut);
    assert_eq!(core.idle_return(), None);
}

// ── ADR-0018 §4: clock in from the computer's sign-in time ───────────

#[test]
fn clock_in_from_sign_in_emits_the_start_and_keeps_the_click_time() {
    let mut core = Core::new(cfg(), t(0));
    let fx = core.handle(Input::ClockInFrom(t(1_000)), t(2_500)).unwrap();
    assert_eq!(emitted(&fx), ["USER_CLOCK_IN"]);
    assert_eq!(emitted_at(&fx, "USER_CLOCK_IN"), Some(t(2_500)));
    match &fx[0] {
        Effect::Emit {
            event: CoreEvent::UserClockInFrom { started_at },
            ..
        } => assert_eq!(*started_at, t(1_000)),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(core.state(), CoreState::Active);
    let payload = CoreEvent::UserClockInFrom {
        started_at: t(1_000),
    }
    .transition_payload();
    assert_eq!(payload["start_source"], "os_sign_in");
}

#[test]
fn clock_in_from_sign_in_is_bounded() {
    let mut core = Core::new(cfg(), t(0));
    assert_eq!(
        core.handle(Input::ClockInFrom(t(100)), t(50)),
        Err(Rejected::StartOutOfRange),
        "in the future"
    );
    assert_eq!(
        core.handle(Input::ClockInFrom(t(0)), t(12 * 3600 + 1)),
        Err(Rejected::StartOutOfRange),
        "more than 12 hours back"
    );
    assert!(core
        .handle(Input::ClockInFrom(t(1)), t(12 * 3600 + 1))
        .is_ok());
    assert_eq!(
        core.handle(Input::ClockInFrom(t(2)), t(12 * 3600 + 2)),
        Err(Rejected::InvalidTransition),
        "already clocked in"
    );
}

// ── presence check (ADR-0024) ─────────────────────────────────────

/// Checks on, with a short window so the tests stay small.
fn presence_cfg() -> CoreConfig {
    CoreConfig {
        input_pattern: Some(pattern::PatternConfig {
            continuous: Duration::from_secs(120),
            ..pattern::PatternConfig::default()
        }),
        ..cfg()
    }
}

/// Clocked in at t(0) with a key held from t(1): input every second.
fn held_key_until(core: &mut Core, from: u64, to: u64) -> Vec<Effect> {
    let mut fx = Vec::new();
    for s in from..=to {
        fx.extend(tick(core, s, s));
    }
    fx
}

fn payload_of(fx: &[Effect], event_type: &str) -> Option<serde_json::Value> {
    fx.iter().find_map(|e| match e {
        Effect::Emit { event, .. } if event.event_type() == event_type => {
            Some(event.transition_payload())
        }
        _ => None,
    })
}

#[test]
fn presence_check_is_off_unless_policy_turns_it_on() {
    let mut core = clocked_in();
    held_key_until(&mut core, 1, 3_000);
    assert_eq!(core.state(), CoreState::Active);
}

#[test]
fn a_held_key_gets_a_presence_check_and_idle_from_when_it_began() {
    let mut core = Core::new(presence_cfg(), t(0));
    core.handle(Input::ClockIn, t(0)).unwrap();
    let fx = held_key_until(&mut core, 1, 121);
    assert!(matches!(core.state(), CoreState::IdlePending { .. }));
    assert_eq!(
        payload_of(&fx, "INPUT_IDLE_5M"),
        Some(serde_json::json!({ "trigger": "input_pattern", "pattern": "continuous" }))
    );
    assert_eq!(core.presence(), Some(pattern::InputPattern::Continuous));

    // The key keeps "typing": the countdown isn't pushed, idle is logged
    // from t(1), and the key doesn't end it.
    let fx = held_key_until(&mut core, 122, 600);
    assert_eq!(emitted_at(&fx, "IDLE_STARTED"), Some(t(151)));
    assert_eq!(core.state(), CoreState::Idle { since: t(1) });
    assert!(emitted(&fx).iter().all(|e| *e != "IDLE_ENDED"));

    // The person comes back and says so.
    let fx = core.handle(Input::ConfirmPresence, t(610)).unwrap();
    assert_eq!(emitted(&fx), ["IDLE_ENDED"]);
    assert_eq!(core.state(), CoreState::Active);
    assert_eq!(core.presence(), None);
    assert_eq!(
        core.idle_return(),
        Some(IdleStretch {
            since: t(1),
            until: t(610)
        })
    );
}

#[test]
fn answering_the_check_carries_on_and_it_waits_30_minutes_to_ask_again() {
    let mut core = Core::new(presence_cfg(), t(0));
    core.handle(Input::ClockIn, t(0)).unwrap();
    held_key_until(&mut core, 1, 121);
    core.handle(
        Input::RespondToPrompt {
            response: PromptResponse::StillWorking,
            note: None,
        },
        t(125),
    )
    .unwrap();
    assert_eq!(core.state(), CoreState::Active);
    assert_eq!(core.presence(), None);
    // Still typing non-stop: no new check inside the cooldown.
    held_key_until(&mut core, 126, 121 + 1_799);
    assert_eq!(core.state(), CoreState::Active);
    let fx = held_key_until(&mut core, 121 + 1_800, 121 + 1_950);
    assert_eq!(
        emitted(&fx)[0],
        "INPUT_IDLE_5M",
        "asked again after 30 minutes"
    );
}

#[test]
fn a_person_who_pauses_is_never_checked() {
    let mut core = Core::new(presence_cfg(), t(0));
    core.handle(Input::ClockIn, t(0)).unwrap();
    // Types 30 s, pauses 5 s, for an hour.
    let mut last = 0;
    for s in 1..3_600 {
        if s % 35 < 30 {
            last = s;
        }
        tick(&mut core, last, s);
    }
    assert_eq!(core.state(), CoreState::Active);
}

#[test]
fn an_ordinary_prompt_still_ends_on_input() {
    // The presence rules don't change ordinary idle (ADR-0018).
    let mut core = Core::new(presence_cfg(), t(0));
    core.handle(Input::ClockIn, t(0)).unwrap();
    tick(&mut core, 0, 300);
    tick(&mut core, 0, 330);
    assert_eq!(core.state(), CoreState::Idle { since: t(0) });
    let fx = tick(&mut core, 400, 400);
    assert_eq!(emitted(&fx), ["IDLE_ENDED"]);
}
