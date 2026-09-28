# ADR-0018 — Log idle time instead of clocking out; clock in from Windows sign-in

- **Status:** Accepted (2026-09-28, decisions set by the project owner)
- **Date:** 2026-09-28
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Supersedes in part:** ADR-0003 §4.5 and ADR-0008 §3, but only the
  *timeout* row: an unanswered prompt no longer closes the session.
  Everything else in both stays.
- **Builds on:** ADR-0004 (append-only events), ADR-0009/0010 (calls,
  silent-call cap), ADR-0013 (reminders), ADR-0015 (policy), ADR-0016
  (working day).
- **Confidence:** Medium-high. The state change is small and mirrors
  existing transitions. Two unknowns are named below: what Windows
  reports as the sign-in time, and how noisy a 2-minute prompt is.

## Context

The owner reviewed the product before the first pilot and asked for
five changes:

1. The idle prompt should appear after **2 minutes**, not 5, and HR or an
   Administrator should be able to change it.
2. **An unanswered prompt should not clock people out after 30 seconds.**
   CloudPunch should log the idle time, and the daily summary should show
   idle and break time.
3. A **clock-in popup at 8 am US Eastern** by default, with time
   starting **from when the person signed in to their computer**.
4. **Starting a break during a call** should show a relevant popup
   (shipped separately, PR #51).
5. HR / Admin change these in a **settings screen**.

The owner chose these answers:
- Offer the sign-in time, never clock in automatically.
- Close the session after **2 hours** of continuous idle.
- Idle stays idle; the **manager decides** whether to accept an
  explanation.
- Settings live **inside the desktop app** for HR and Administrator.

## Decision

### 1. A new payroll state: `IDLE`

```
ACTIVE ──INPUT_IDLE_5M──► IDLE_PENDING ──(grace ends, no answer)──► IDLE
                              │                                    │
                              └─USER_PROMPT_RESPONSE (as today)     ├─ input returns ──► ACTIVE   (IDLE_ENDED)
                                                                    ├─ idle cap ───────► CLOSED   (IDLE_CAP_REACHED)
                                                                    └─ USER_CLOCK_OUT ─► CLOSED
```

- **`IDLE_STARTED`** (`IDLE_PENDING → IDLE`) replaces `PROMPT_TIMEOUT_30S`
  for new clients. Its payload is `{ "idle_since": <last input, RFC 3339> }`.
  **Idle time starts at the last input**, not when the prompt appeared.
  - The minutes before the prompt were silent too, and ADR-0008 already
    made them not payable on timeout.
  - `PROMPT_TIMEOUT_30S` stays valid for past history (append-only). The
    backend keeps closing a session on it, so old events replay the same.
- **`IDLE_ENDED`** (`IDLE → ACTIVE`) is sent by the desktop on the first
  input after idle. It carries the same `idle_since`, and `client_ts` is
  the moment input returned.
  - If a call is still running, the usual `MEDIA_DEVICE_STATE` moves it
    on to `ON_CALL`.
- **`IDLE_CAP_REACHED`** (`IDLE → CLOSED`) is sent when idle has lasted
  `idle.max_idle_minutes` (default **120**, range 15–480) since
  `idle_since`.
  - The session closes at that moment with
    `closed_reason = 'idle_cap'`.
  - The whole idle stretch is recorded as idle.
- **`USER_CLOCK_OUT` from `IDLE`** is legal. The session closes at the
  click, and the idle stretch stays idle.
- A silent call that reaches the prompt (ADR-0010) and goes unanswered
  becomes `IDLE` the same way.

The event names `INPUT_IDLE_5M` and `PROMPT_TIMEOUT_30S` keep their old
names, although the numbers are now policy-driven. Renaming them would
rewrite history.

### 2. Idle is never worked time; explanations don't change that

- Idle is its own segment kind (`idle`) on the employee's timeline, in
  day history (ADR-0016), and in totals (`idle_ms`). It is **not
  payable** and not counted in "worked".
- **Welcome back.** When input returns after idle, the window comes
  forward and asks:
  - "Welcome back — you were idle 13:02–13:25 (23 min). What were you
    doing?"
  - Answers: *Working away from the computer*, *In a meeting*, *On a
    phone call*, *On a break*, *Nothing — I was idle*, plus an optional
    note.
- The answer is sent as **`USER_IDLE_EXPLAINED`**. It is an annotation
  that changes no state: `{ idle_since, idle_until, explanation, note }`.
  The manager sees it next to the idle stretch and accepts or rejects it
  when approving the timesheet (invariant 3's approval gate). **Nobody
  self-approves idle time**, and the ledger stays append-only
  (invariant 2).
- Skipping the question is allowed. The stretch then stays unexplained
  idle.

### 3. Idle prompt after 2 minutes

- The `idle.threshold_seconds` default becomes **120** (range stays
  60–3600).
- `idle.grace_seconds` stays 30. It is now "how long the prompt waits
  before idle is logged", not "before you're clocked out".
- Both, plus `idle.max_idle_minutes`, are HR / Admin settings (§5).
- The prompt is still suppressed during a detected call (ADR-0009). Two
  minutes is short for reading a long document, so the prompt's wording
  stays gentle, and **"Still working" keeps those minutes payable**
  (ADR-0008 §3, unchanged).

### 4. Clock-in popup at 8 am US Eastern, from the Windows sign-in time

- **Policy:**
  - `reminders.clock_in_prompt_at`: `"08:00"`, or `null` to turn it off;
  - `reminders.clock_in_prompt_tz`: `"America/New_York"`, which follows
    daylight saving, so 8:00 ET is 17:30 IST in summer and 18:30 IST in
    winter.
  - Both are HR / Admin settings.
- **When it opens.** From that time on each weekday, the window comes
  forward if **all** of these hold:
  - the person is signed in to CloudPunch and clocked out;
  - nothing has been tracked in the current working day;
  - they are at the computer.
  - If they reach the computer later, it opens as soon as they are.
  - It shows at most once per working day. After that, the existing
    "Ready to clock in?" nudges continue (ADR-0013 §7).
- **What it offers.** "Good morning — you signed in to Windows at 08:05.
  Clock in from 08:05?", with **Clock in from 08:05** and **Clock in
  now**.
  - The Windows sign-in time is the start of the current Windows logon
    session, as reported by the OS. The desktop records only that
    timestamp.
  - It is offered only if it falls in the current working day, no more
    than 12 hours ago, and after the end of the last session.
- **How it is recorded.** `USER_CLOCK_IN` gets an optional payload
  `{ "start_source": "os_sign_in", "started_at": <sign-in time> }`.
  `client_ts` stays the click time, so clock-drift checks are unaffected.
  - The backend opens the session at `started_at` when it passes the same
    bounds, and otherwise at `client_ts`.
  - The timesheet flags such sessions as **"started from Windows
    sign-in"**, so the manager sees the difference between the click
    and the start.
- **Never an automatic clock-in.** The person always confirms.

### 5. Settings screen for HR and Administrator

- It is a **Settings** screen inside the desktop app. It appears only
  when the access token's `roles` claim holds `HR` or `Administrator`
  (invariant 6: the server re-checks every write).
- It edits the existing policy overrides (ADR-0015):
  - an Administrator edits the **company-wide** values;
  - HR edits **department** values (ADR-0015's scopes).
- Every save is audited as today. First fields:
  - idle prompt after (min);
  - prompt wait (s);
  - idle cap (min);
  - clock-in popup time and zone;
  - long day (h);
  - long-shift check (h).
- A web dashboard remains the long-term home and will reuse the same API.

## Consequences

- **Positive:**
  - Nobody loses a shift to a missed 30-second prompt.
  - Idle becomes visible and explainable instead of silently cutting
    the day.
  - Managers get the facts (objective idle stretches from input) plus
    the person's own account, and decide.
  - The start of the day matches when people actually sat down.
- **Negative:**
  - Sessions stay open up to 2 hours longer when someone walks away, so
    "open session" views must show `IDLE` clearly.
  - Migration **0004** widens two CHECK lists: `time_event.event_type`
    (`IDLE_STARTED`, `IDLE_ENDED`, `IDLE_CAP_REACHED`,
    `USER_IDLE_EXPLAINED`) and `time_session.closed_reason`
    (`idle_cap`). The migration is additive, and every environment
    needs it before new clients connect.
  - Old clients still send `PROMPT_TIMEOUT_30S` and still close; that's
    acceptable during rollout.
  - A backdated start from sign-in is a payroll-sensitive number. That's
    why it is bounded, flagged, and subject to approval.
- **Unknowns to verify:**
  - Whether the Windows sign-in time survives fast user switching and
    Remote Desktop reconnects (we read the logon-session start, not the
    latest unlock).
  - Whether a 2-minute prompt produces too many prompts in real use.
    Watch the pilot, and HR can raise it.
- **macOS:** the sign-in time comes from the login session start. It
  will be verified in 2b.8.

## Alternatives considered

- **Keep the 30-second clock-out, add idle only as a report.** Rejected
  by the owner: it still cuts shifts.
- **Let the answer convert idle into worked time.** Rejected by the
  owner: employees would self-approve paid time.
- **Automatic clock-in at Windows sign-in.** Rejected by the owner: early
  sign-ins would start pay without consent.
- **Reuse `PROMPT_TIMEOUT_30S` with a payload flag for "log idle".**
  Rejected: the same event would mean two different things in the
  ledger.
- **No idle cap.** Rejected by the owner: a forgotten laptop would keep a
  session open overnight.
