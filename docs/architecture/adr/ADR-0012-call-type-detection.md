# ADR-0012 — Call type detection (Teams / Zoom / other)

- **Status:** Accepted (2026-09-24)
- **Date:** 2026-09-24
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Supersedes (in part):** ADR-0003 §1 (note that `ON_CALL` is
  reported only as `ACTIVE`) and §7 ("which app… we do not detect");
  ADR-0009 §1 (payload is exactly `{ in_use }`); ADR-0011 §1 (calls
  visible to the employee only) and §2 (the "On a phone call" tag).
  Their other content stands.
- **Amends:** invariant 1 in `CLAUDE.md` (no per-app usage).
- **Confidence:** High on the mechanism. The privacy position is the
  project owner's decision; see §5.

## Context

Since PR #8 the agent knows *that* a microphone capture session is
active, but not what kind of call it is. The project owner wants the
timeline, the manager view, and reports to distinguish Teams and Zoom
calls from other calls automatically, without the employee tagging
each one.

Invariant 1 and ADR-0003 §7 / ADR-0009 §1 forbid recording which
application holds the microphone. This ADR makes a narrow, explicit
exception.

## Decision

### 1. Detect the call type from the process holding the microphone

When a capture session is active (`audio_session.rs`), the agent reads
the owning process id (`IAudioSessionControl2::GetProcessId`), resolves
its executable **file name** (`QueryFullProcessImageNameW`), and maps it
through an allowlist to a category:

| Executable (case-insensitive) | `call_type` |
|---|---|
| `ms-teams.exe`, `teams.exe` | `teams` |
| `zoom.exe` | `zoom` |
| anything else, or the camera alone | `other` |

If several apps capture at once, Teams wins over Zoom, and either over
`other`.

The allowlist is compiled into the agent for now; it moves to policy
(`idle.call_type_apps`) when policy fetch exists.

### 1a. Apps that hold the microphone while idle are ignored

Some softphones keep their microphone stream open whenever they run
(found in the owner's smoke test: an idle `ace dialer.exe` showed as
"On a call"). An open session from such an app is not a call. These
apps are on a compiled-in ignore list; their microphone use is never
counted, in the session check or the consent-store fallback. Calls on
them are not tracked (owner's decision).

### 2. Record the category only

`MEDIA_DEVICE_STATE` gains an optional field:

```json
{ "in_use": true, "call_type": "teams" | "zoom" | "other" }
```

- Present only when `in_use` is `true`.
- The executable name, path, process id, window title, meeting name,
  participants, and all audio and video are **never** stored, logged,
  or sent. The file name exists only transiently in agent memory to
  pick the category.
- A change of app mid-call (e.g. a Teams call followed by a Zoom call
  without the microphone going idle) records another
  `MEDIA_DEVICE_STATE { in_use: true, call_type }`; state stays
  `ON_CALL`.
- The backend rejects an unknown `call_type`.

### 3. Who sees it

The employee, their manager, HR, and reports see the call type ("Teams
call 10:30–11:00"). This supersedes ADR-0003 §1's note and ADR-0011 §1.
Payability is unchanged: all `ON_CALL` time is payable as before.

### 4. What it cannot tell

- A Teams **meeting vs webinar vs 1:1 call** (same process); likewise
  Zoom.
- Calls in a **web browser** (Google Meet, Teams web): the browser is
  the process, so they read as `other`.
- Calls on a **cell phone**, or on ignored apps (§1a).

### 5. Privacy position

The project owner's reasoning: CloudPunch does not listen to or record
calls; it logs which kind of work-communication activity was under way.
The owner declined a legal / HR (DPDP Act) review before shipping. The
employee privacy notice is updated to disclose the call type before
this ships to anyone other than the owner.

Recorded risk: the call type is per-app usage for a small, named set of
apps, visible to managers. Widening the set, recording app names, or
adding non-communication apps requires a new ADR.

### 6. The "On a phone call" tag is removed

The voluntary "On a phone call" tag (ADR-0011 §2) is removed from the
home window and tray; "In a meeting" stays. Only automatically detected
calls are recorded as calls.

## Consequences

### Positive

- Timeline, manager view, and reports show the call mix without manual
  tagging.
- Idle softphones no longer show as a call all day.

### Negative

- Invariant 1 now has a named exception; the product can no longer say
  "no per-app usage" without qualification.
- Browser calls and meeting-vs-webinar remain indistinguishable.
- Cell-phone calls and calls on ignored apps aren't recorded as calls;
  they fall to the idle prompt.
- Renamed or updated executables fall back to `other` until the
  allowlist is updated.

## Alternatives considered

- **Employee labels each call.** Rejected by the owner: manual effort.
- **Boolean only (status quo).** Rejected by the owner.
- **Record the executable name.** Rejected — more than the category is
  needed for no purpose.

## References

- ADR-0003 §1, §7; ADR-0009; ADR-0011
- `docs/policy/employee-privacy-notice.md`
- `CLAUDE.md` invariant 1
