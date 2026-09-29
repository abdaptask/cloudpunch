# Idle-policy defaults and admin-configurable knobs

- **Status:** Accepted (Phase 0).
- **Owner:** CloudPunch administrator (per deployment).
- **Related:** ADR-0003 (state machine), ADR-0005 (source of truth),
  `docs/policy/employee-privacy-notice.md`.

This document lists every idle-related and break-related setting that
CloudPunch supports, their defaults, what they do, and who is
allowed to change them.

The defaults were chosen from the Phase 0 conversation on 2026-09-23
and can be overridden at three scopes:

1. **Global (tenant-wide)** — set by an Administrator.
2. **Team / department** — overrides the global default for a
   specific team; set by an Administrator or HR.
3. **Per-employee** — an override on a single employee for
   accessibility or accommodation reasons; set by an Administrator
   or HR **with a required `reason` field** stored in the audit log.

Precedence from most specific to most general: per-employee → team
→ global.

All values live in `packages/policy-schema/idle-policy.schema.json`
and are validated at load time. Values outside the accepted ranges
are rejected at the admin UI.

How overrides are stored, merged, versioned and delivered to the
desktop (`GET /v1/me/policy`), and when a change takes effect, is in
ADR-0015.

## 1. Inactivity threshold

**Setting:** `idle.threshold_seconds`
**Default:** `120` (2 minutes; was 300 before ADR-0018)
**Range:** 60 – 3600
**Effect:** Time without a keyboard or pointer event before
CloudPunch shows the idle prompt. Below this, the user is `ACTIVE`
(or `ON_CALL` if mic/camera is in use).

**When to lower:** rarely; 2 minutes is already short.
**Note:** reading a long document can mean two minutes without input.
"Still working" keeps those minutes payable (ADR-0008 §3).
**When to raise:** deeply focused roles (research, design) where
silent stretches are normal — though raising too high defeats the
purpose. Consider an `IDLE_PENDING` "still working" click as a
partial acknowledgement of presence rather than a punishment for
thinking.

## 2. Grace window before idle is logged

**Setting:** `idle.grace_seconds`
**Default:** `30`
**Range:** 10 – 300
**Effect:** After the prompt appears, CloudPunch waits this long for an
answer, then **logs idle time** (ADR-0018). The person stays clocked
in, and idle is counted from their last input. When they return, the
window asks what they were doing. Their answer is attached for the
manager, and the time stays idle (not worked) unless the manager
accepts it at approval.

Before ADR-0018, an unanswered prompt clocked the person out
(`reason=idle_auto_clock_out`). Older app versions still do this until
they are updated.

**Setting:** `idle.max_idle_minutes`
**Default:** `120` · **Range:** 15 – 480, or `null` to disable
**Effect:** After this much continuous idle, the session closes
(`reason=idle_cap`), dated exactly when the cap was reached. This
holds even if the laptop slept past it. It stops a forgotten laptop
from keeping a shift open overnight.

## 3. Auto-classification of unresponsive idle time

**Setting:** `idle.count_as_payable_when_unresponsive`
**Default:** `false` (do NOT count as payable)
**Effect:** When the grace timer expires with no response, the idle
stretch (from the last input) is recorded as **idle** and does **not**
contribute to payable hours (ADR-0018 §2). The person's explanation
never changes that on its own; the manager decides.

**Do not set to `true` without a documented policy reason and
legal review.** Paying for time an employee did not confirm they
were working exposes ApTask to wage-and-hour risk and defeats the
integrity of the timesheet.

## 4. Mic / camera in-use detection

**Setting:** `idle.suppress_prompt_when_media_active`
**Default:** `true`
**Effect:** If the operating system reports that any application on
the device is using the microphone or the camera, the idle prompt is
suppressed and the state transitions to `ON_CALL` (which is payable,
same as `ACTIVE`). See `docs/policy/employee-privacy-notice.md` for
the plain-language explanation.

**When to disable:** roles where mic/camera use is not correlated
with work (rare). Disabling means idle prompts fire during meetings.

**Setting:** `idle.media_state_debounce_seconds`
**Default:** `5`
**Range:** 1 – 60
**Effect:** How long the mic/camera must be continuously idle before
we consider a call ended and restart the inactivity timer. Filters
out transient audio events like system beeps.

**Setting:** `idle.max_silent_call_minutes`
**Default:** `30`
**Range:** 15 – 480, or `null` to disable
**Effect:** While on a call, if there has been no keyboard or pointer
input for this long (measured from the later of the call starting and
the last input), CloudPunch shows the normal idle prompt anyway. Any
input during the call resets it. Bounds the case where someone leaves
a meeting running, or an app holds the microphone open, and walks
away. The call time before the prompt stays payable; an unanswered
prompt ends the session as usual. See ADR-0010.

**When to raise or disable:** roles with long listen-only sessions
(trainings, all-hands) where a prompt every 30 minutes is disruptive.

**Setting:** `idle.call_type_apps`
**Default:** `ms-teams.exe`, `teams.exe` → `teams`; `zoom.exe` → `zoom`
**Range:** up to 50 entries of `{process, call_type}`, where
`call_type` is `teams`, `zoom` or `other`
**Effect:** which apps' microphone use counts as a call, and the
category shown for it. This is configuration only: CloudPunch records
the category, never the app's name (ADR-0012, ADR-0015 §8).

**Setting:** `idle.call_type_ignored`
**Default:** `["ace dialer.exe"]`
**Effect:** apps that hold the microphone without being a call (for
example a dialler that keeps it open all day). They never start the
"on a call" state.

## 5. Idle prompt options

**Setting:** `idle.prompt_options`
**Default:** `["still_working", "bio_break", "meal_break",
"on_phone_call", "working_away", "end_shift"]`
**Effect:** Which options are shown in the prompt. Options can be
removed but never renamed — the state-machine transitions in
ADR-0003 reference them by identifier. Adding a new option requires
an ADR update.

## 6. Break types (ADR-0023)

Five fixed types. Events record only the id, never the label.

| id | Default label | `pay` | `max_minutes` | `enabled` |
|---|---|---|---|---|
| `bio` | Bio break | `paid_up_to_limit` | 10 | `true` |
| `meal` | Meal break | `unpaid` | 60 | `true` |
| `rest` | Tea break | `paid_up_to_limit` | 15 | `true` |
| `personal` | Personal | `unpaid` | 30 | `true` |
| `other` | Other break | `unpaid` | `null` (none) | `false` |

Each entry has the same settings:
- **`break.<id>.enabled`:** whether the app offers it. History keeps
  disabled types. At least one type must stay enabled; the Settings
  save refuses otherwise.
- **`break.<id>.label`:** 1–30 characters, shown in the app and to the
  person's manager.
- **`break.<id>.pay`:**
  - `paid`;
  - `unpaid`;
  - `paid_up_to_limit`: paid up to `max_minutes`, the rest unpaid. The
    limit applies to each break on its own.
- **`break.<id>.max_minutes`:** 5–180 (`other` may be `null`). Past it,
  CloudPunch shows a soft "Still on break?" nudge and doesn't change the
  state; time beyond it is still break time.

**Day totals:** `paid_break_ms` and `unpaid_break_ms` next to
`breaks_ms`, from the person's policy as it stands now.

**Deprecated:** `break.bio.payable_up_to_cap` and `break.meal.payable`
are still accepted so stored overrides stay valid, but `pay` decides.

## 7. Meal-break prompt

**Setting:** `break.meal.min_minutes_before_prompt`
**Default:** `0` (no prompt)
**Effect:** If set > 0, CloudPunch will show a "Time for lunch?"
prompt after this many minutes since the last meal break started
(useful only for teams with regulated meal-break requirements).

## 8. Away-reason handling

**Setting:** `away.require_note`
**Default:** map by reason — `working_away: true`, `phone_call:
false`, `meeting: false`, `training: false`, `other: true`
**Effect:** Whether the user must type a short note when marking away
with each reason.

**Setting:** `away.payable_reasons`
**Default:** `["working_away", "phone_call", "meeting", "training"]`
**Effect:** Which away-reasons count toward payable time. `other` is
excluded by default.

**Setting:** `away.offer_training`
**Default:** `true`
**Effect:** Whether the app offers Training as an Away reason
(ADR-0023 §1).

## 9. Screen-lock and sleep tolerance

**Setting:** `system.max_lock_duration_minutes`
**Default:** `120` (2 hours)
**Effect:** If the screen stays locked longer than this while a
session is open, the state transitions to
`ERROR_REQUIRING_ATTENTION` and a ReviewCase is created for the
manager. The assumption is that a long lock during a "working"
session is either a forgotten clock-out or an unattended device.

**Setting:** `system.max_sleep_duration_minutes`
**Default:** `120`
**Effect:** Same as above for system sleep.

## 10. Multi-device conflict resolution

**Setting:** `multi_device.on_second_signin`
**Default:** `prompt_take_over` (offer the user Take Over Here /
Cancel)
**Alternatives:**
- `auto_take_over` — silently close the other session and open here.
- `deny` — refuse the second sign-in until the other session ends.

`auto_take_over` is the fastest UX but hides that another device was
active; `deny` is the safest but forces the user to remember to
close old sessions. Default (`prompt_take_over`) surfaces the
conflict without blocking work.

## 11. Autostart on OS login

**Setting:** `autostart.enabled`
**Default:** `false`
**Effect:** Whether the CloudPunch agent launches when the user signs
in to Windows or macOS. Even when enabled, the agent opens to the
tray/menu bar in a "clocked out" state — it does not automatically
clock the user in.

**Setting:** `autostart.employee_can_override`
**Default:** `true`
**Effect:** Whether individual employees can toggle autostart from
the agent settings. If `false`, only administrators can change it.

## 12. Notification quiet hours

**Setting:** `notifications.quiet_hours_start` /
`notifications.quiet_hours_end`
**Default:** `"22:00"` / `"07:00"` in the user's local timezone
**Effect:** During quiet hours, only critical notifications
(auto-clock-out, session-frozen, correction rejected) are delivered.
Reminder notifications are held until after the window.

**Desktop reminders (ADR-0013):**

**Setting:** `reminders.on_clock_minutes`
**Default:** `30` · **Range:** 10 – 240
**Effect:** While clocked in and the CloudPunch window is hidden, a
notification every this many minutes ("You're on the clock — 2h 30m
this session"). Not during a detected call, while the idle prompt is
showing, or in quiet hours.

**Setting:** `reminders.long_shift_hours` /
`reminders.long_shift_repeat_hours`
**Default:** `9` / `2` · **Range:** 4 – 16 / 1 – 8
**Effect:** After this many hours in one session, CloudPunch brings its
window forward: "You've been clocked in for 9 hours — still working?"
(**Still working** asks again after the repeat interval; **Clock out**).
Delivered even in quiet hours — it exists to catch forgotten overnight
clock-ins.

**Setting:** `reminders.clock_in_nudge_minutes`
**Default:** `30` · **Range:** 10 – 240, or `null` to disable
**Effect:** Signed in, using the computer, but not clocked in yet today:
a "Ready to clock in?" notification, the first about a minute after the
computer is in use, then every this many minutes. There are no nudges
once anything has been tracked today, in quiet hours, or while the
CloudPunch window is showing. ADR-0013 §7.

**Setting:** `reminders.clock_in_prompt_at` / `reminders.clock_in_prompt_tz`
**Default:** `"08:00"` / `"America/New_York"` · `null` time turns it off
**Effect:** On weekdays in that zone, from that time, the window comes
forward with "Time to clock in" for someone at the computer, signed in
and not yet clocked in. It shows once a day. It offers to start from
when they signed in to the computer (logon, unlock or wake), if that is
1 minute to 12 hours ago and after the last session. Never automatic.
It follows the zone's daylight saving (8:00 New York = 17:30 IST in
summer, 18:30 IST in winter). ADR-0018 §4.

**Setting:** `reminders.long_day_hours`
**Default:** `8` · **Range:** 4 – 16
**Effect:** End-of-day summary. A clock-out or sign-out after at least
this many hours worked today shows the "Trip complete" animation (the
needle parks, an odometer rolls up the day, "See you tomorrow").
Shorter days get a quiet one-line summary. Display only. ADR-0013 §8.

The break-cap nudges (§6, §7) use the same notifications and respect
quiet hours.

**Setting:** `notifications.rate_limit_per_hour`
**Default:** `6`
**Effect:** Maximum notifications any single user receives per hour,
across all channels. Excess are collapsed or dropped.

## 13. Clock-drift tolerance

**Setting:** `integrity.clock_drift_threshold_seconds`
**Default:** `60`
**Range:** 10 – 300
**Effect:** Wall-clock jump vs monotonic-clock delta beyond this
between two samples fires `CLOCK_DRIFT_DETECTED`, freezing the
session with a ReviewCase.

**Setting:** `integrity.clock_sample_interval_seconds`
**Default:** `30`
**Effect:** How often the agent samples both clocks.

## 14. Setting change audit

Every change to any policy setting writes an `audit_log` row with:

- Who changed it (`actor_user_id`)
- What changed (`setting_key`, `previous_value`, `new_value`)
- Which scope (global / team / per-employee)
- Reason (required for per-employee overrides)
- Correlation ID for tracing across services

The reconciliation dashboard shows recent policy changes so admins
can see who tuned what and when.

## 15. Recommended review cadence

- **Monthly:** review notification volume and quiet-hours
  effectiveness.
- **Quarterly:** review the auto-clock-out rate and whether it
  correlates with any team; adjust thresholds if a team is
  consistently getting cut off legitimately (or padding hours).
- **On any wage-and-hour policy change:** re-verify defaults with
  HR and legal.
- **On any DPDPA guidance update:** revisit notification defaults
  and setting-change audit fields.
