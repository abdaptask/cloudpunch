# ADR-0024 — Presence check for propped keys and mouse jigglers

- **Status:** Accepted (2026-09-29, the owner approved the recommendation)
- **Date:** 2026-09-29
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0008 (idle prompt), ADR-0010 (prompt triggers),
  ADR-0018 (idle logging, the manager decides), CLAUDE.md invariant 1
  (no content capture).
- **Confidence:** Medium. The signals are simple, and only the time since
  the last input is read. The thresholds need tuning on real pilot data;
  false positives are handled by asking the person, not by the numbers.

## Context

The owner asked whether CloudPunch can tell when someone keeps it
"active" without working: a weight on a key, or a mouse jiggler
(hardware, or software that moves the pointer).

The app already polls Windows `GetLastInputInfo` once a second
(`watchers/idle.rs`). That returns one number: when the last keyboard
or mouse input happened. It doesn't say what was pressed, which device
it was, or where the pointer went.

That timing alone gives both tricks away:
- **A held or weighted key** makes auto-repeat input every few
  milliseconds, without stopping. People always pause, to read, think
  or look away.
- **A jiggler** makes input at a very regular rhythm (for example every
  30.0 s) and nothing in between. People are irregular.

## Decision

### 1. Two patterns, from input timing only

- **Continuous:** no gap of at least `min_gap_seconds` (default 3)
  between inputs for `continuous_minutes` (default 20).
- **Periodic:** over `periodic_minutes` (default 10), all of these:
  - at least 10 inputs;
  - every gap between them 2 s or more;
  - the gaps no more than 1 s apart from each other (nearly identical);
  - no burst of faster input in between.

**Only the last-input timestamps are used.** They're kept in memory for
the window and then dropped. Nothing about keys, devices or the pointer
position is read.

**Explicitly not done:** low-level keyboard or mouse hooks, or raw input.
Those would see which keys were pressed, which breaks invariant 1, and
antivirus tools flag them.

### 2. Ask, don't accuse: the presence check

- **When a pattern is spotted:** CloudPunch shows the idle prompt as a
  **presence check**, "Are you there? Choose an option to carry on",
  with the usual answers.
- **Why it works:** a propped key or a jiggler can't click a button.
- **Recorded as:** the ADR-0010 mechanism, `INPUT_IDLE_5M` with
  `trigger: "input_pattern"` and `pattern: "continuous" | "periodic"`,
  from ACTIVE only.
- **Answered:** it's handled like any prompt answer. The day view shows
  "Presence check · answered" so the manager can see it happened.
- **Not answered within the grace:** logged idle (ADR-0018), with
  `idle_since` set to **when the pattern began**, not when the check
  opened. So the propped time isn't counted as worked. The manager
  decides, as for any idle.
- **Not while** on a call, on a break or away, since the idle prompt
  isn't shown in those states either. **At most once per 30 minutes**,
  so a genuine fast typist isn't nagged.

### 3. Visible to everyone involved

- **The employee** sees the presence check on their own timeline.
- **The manager and HR** see it in the manager day view and in the
  Exceptions report (ADR-0025).
- **The privacy notice** describes it before it is turned on.

### 4. Off until HR turns it on

- **Policy settings:**
  - `idle.input_pattern_check.enabled` (default **false**);
  - `continuous_minutes` (10–120, default 20);
  - `periodic_minutes` (5–60, default 10);
  - `min_gap_seconds` (2–10, default 3).
- **Settings:** a switch under Idle for HR and Administrators.
- **Off by default,** so employees are told first (the privacy notice)
  and HR chooses when to start.

## Consequences

- **Positive:**
  - It deters and surfaces propping, and costs honest people at most a
    click every 30 minutes, only when they've typed non-stop.
  - It adds no new data category. It's idle timing the app already
    reads, and the flag is an idle-prompt trigger.
- **Negative and risks:**
  - **False positives:** very fast continuous typists, a genuinely stuck
    key, and accessibility tools (auto-clickers, eye-gaze dwell). The
    check asks rather than deducts, and the manager decides. HR can raise
    the thresholds or turn it off for a person (employee-scope override).
  - **It can be beaten** by someone who randomises a software jiggler
    with bursts. It's a deterrent, not a guarantee.
  - **Remote-desktop sessions** report input from the remote side.
    Behaviour there is unverified.
  - **Tuning needs pilot data.** The defaults are a starting point.

## Alternatives considered

- **Low-level keyboard/mouse hooks, or raw input** (key-repeat flags,
  injected-input flags, device ids). Rejected: they expose key codes to
  the app, which is content (invariant 1), and security tools flag
  them.
- **Flag only, with no presence check.** Rejected: it accuses on
  numbers alone.
- **Silent detection** (the manager sees it, the employee doesn't).
  Rejected: not transparent, and against the privacy notice's spirit.
- **Screenshots or webcam presence.** Rejected outright (invariant 1).
