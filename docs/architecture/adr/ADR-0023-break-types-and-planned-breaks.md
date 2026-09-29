# ADR-0023 — Break types, planned breaks, and break settings

- **Status:** Accepted (2026-09-29, approved by the project owner: Other off by default, "Tea break" as the default name)
- **Date:** 2026-09-29
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0003 (state machine, `break_kind`, payability
  defaults §6), ADR-0004 (event model), ADR-0011 (away tags,
  `away.payable_reasons`), ADR-0013 (break cap reminders), ADR-0015
  (policy storage, scopes), ADR-0016 (day history segments), ADR-0018 §5
  (HR settings form).
- **Confidence:** Medium-high. It extends existing structures (policy
  JSON, event payloads, day segments) and needs no database migration.
  The paid/unpaid totals are new logic: ADR-0015 left payability "stored
  but not yet acted on".

## Context

The owner asked:
- what someone should use when they'll be away from the desk for about
  20 minutes and say so in advance;
- for break categories beyond bio and meal;
- for HR to set those categories from the Settings panel.

What exists today (verified in code):
- **Breaks:** `bio`, `meal` and `other` in Rust and the backend.
  - The app offers only Bio and Meal. No screen or tray menu offers
    Other.
  - Caps are bio 10 min and meal 60 min. They only raise a reminder;
    nothing is cut off.
- **Away (counts as work):** `working_away`, `phone_call` and `meeting`.
  Only Meeting can be picked by hand; the idle prompt offers the rest.
- **Checks at ingest:** `USER_START_BREAK` has no event schema. The
  server doesn't check `break_kind`, so an unknown value silently becomes
  `other`.
- **Payability:** the policy flags (`bio.payable_up_to_cap`,
  `meal.payable`, `away.payable_reasons`) are never used. Day totals have
  a single `breaks_ms` figure.
- **HR Settings** has no break or away fields.

The owner decided (2026-09-29):
- the list below;
- no Prayer or Medical types (religion and health are sensitive
  personal data, and naming them invites unfair treatment; Personal
  covers both without saying why);
- **managers see the break type**.

## Decision

### 1. A fixed catalogue with permanent ids

| id | Default label | Default pay | Default limit | On by default |
|---|---|---|---|---|
| `bio` | Bio break | Paid up to limit | 10 min | Yes |
| `meal` | Meal break | Unpaid | 60 min | Yes |
| `rest` (new) | Tea break | Paid up to limit | 15 min | Yes |
| `personal` (new) | Personal | Unpaid | 30 min | Yes |
| `other` | Other break | Unpaid | none | No (Personal covers it) |

- **Events carry only the id, never the label.** Renaming a type never
  rewrites history, and ids are never reused or removed.
- HR can't create new types. A fixed list keeps the greytHR export's
  paid/unpaid split well defined and keeps free text out of events
  (invariant 1).
- **Away gains `training`** (counts as work, paid, no note required by
  default). The `other` away reason stays schema-only, as today.

### 2. "Back in…": planned breaks

- Starting a break asks **"Back in?"**, with the choices 5, 10, 15, 20,
  30, 45, 60 minutes and **Not sure**. The default is the type's limit,
  so one tap is enough.
- `USER_START_BREAK.payload` gains **`planned_minutes`** (an integer from
  that fixed list, or `null`). No note field: a personal break never
  says why.
- **Reminder:** once the planned time is up, "Back yet? You planned 20
  min" (at most once per break, respecting quiet hours as today). The
  type's limit reminder still applies after that.
- **Managers see planned vs. actual**, for example "Personal · planned 20
  · took 24".
- **The answer to the 20-minute question:**
  - away for work: **Away → Working away** (or Meeting or Training),
    which counts as work;
  - personal: **Personal, back in 20**, which is unpaid.
  - Either way there's no idle popup meanwhile, since that already
    doesn't run during a break or Away.

### 3. Pay rules, calculated on the server

- Each type has `pay` set to one of:
  - `paid`;
  - `unpaid`;
  - `paid_up_to_limit`: paid up to `max_minutes`, and the rest unpaid.
- **Day totals** gain `paid_break_ms` and `unpaid_break_ms`, alongside
  the existing `breaks_ms` (which is kept for compatibility). They're
  shown on the day view, and they're what the greytHR export's
  `paidBreakMinutes` / `unpaidBreakMinutes` will use later.
- The rule applied is the one in the policy **in force when the break
  started** (ADR-0015 keeps versions). A change applies only from then
  on.
- `away.payable_reasons` gains `training` in its default.

### 4. Policy shape

The `break` object gets one entry per type, all with the same shape:

```json
"break": {
  "bio":      { "enabled": true,  "label": "Bio break",   "pay": "paid_up_to_limit", "max_minutes": 10 },
  "meal":     { "enabled": true,  "label": "Meal break",  "pay": "unpaid",           "max_minutes": 60 },
  "rest":     { "enabled": true,  "label": "Tea break",   "pay": "paid_up_to_limit", "max_minutes": 15 },
  "personal": { "enabled": true,  "label": "Personal",    "pay": "unpaid",           "max_minutes": 30 },
  "other":    { "enabled": false, "label": "Other break", "pay": "unpaid",           "max_minutes": null }
}
```

- **Existing keys stay valid:**
  - `bio.payable_up_to_cap` and `meal.payable` are read when `pay` is
    absent;
  - `meal.min_minutes_before_prompt` is unchanged.
- **Limits on values:**
  - `label` is 1–30 characters, plain text, and HTML-escaped wherever
    it's shown;
  - `max_minutes` is 5–180, or `null` for none;
  - at least one type must stay enabled.
- **Scopes as today** (ADR-0015): company, then team, then employee
  overrides.
- Apps that don't understand the new entries ignore them (serde
  defaults), so older desktops keep working with Bio and Meal.

### 5. Settings panel (HR and Administrator)

- A new **Breaks** section, with one row per type:
  - an on/off switch;
  - the name;
  - the pay rule (Paid / Unpaid / Paid up to the limit);
  - the limit, in minutes.
- **Away:** a switch for whether Training is offered.
- Who can change it: the same capability that edits policy today. The
  existing policy audit covers it.

### 6. The app

- The break chips become **Break ▾**, a menu of the enabled types by
  label, followed by "Back in?". The tray menu and the idle prompt
  offer the same enabled types.
- **Away gets Training**, next to In a meeting.
- **Timeline and dial colours:** one break colour per pay rule (paid or
  unpaid), with the label in the tooltip. That avoids a new colour for
  every type.

### 7. Validation (closes a gap)

- **A new `user-start-break.schema.json`:**
  - `break_kind` is one of `bio`, `meal`, `rest`, `personal`, `other`;
  - `planned_minutes` is one of the fixed list, or `null`;
  - `additionalProperties: false`.
- **Ingest checks `break_kind`** instead of silently turning unknown
  values into `other`. Events already stored are untouched (invariant
  2); the day builder keeps its `other` fallback for them.
- `USER_MARK_AWAY.away_reason` gains `training`.

### Amendments found while building (approved by the owner, 2026-09-29)

1. **§3, "the policy in force when the break started", isn't possible
   today.**
   - Policy overrides are replaced in place (`policy_override`, one row
     per scope), and the version is only a content hash. So there's no
     record of what a policy said last week.
   - **What's built:** totals use the person's policy **as it stands
     now**, so a pay-rule change also recalculates earlier days on
     screen.
   - This is safe for payroll only because the approval gate
     (invariant 3) will lock a `timesheet_version` before anything is
     exported. That lock isn't built yet.
   - **Decision:** the current policy for the pilot. A `policy_history`
     table (a migration keeping every version with its time) is built
     with the approval gate and greytHR export, so each break is then
     paid by the rule of its day.
2. **§4, the old pay flags.** `pay` now has a schema default, so "read
   `payable_up_to_cap` / `payable` when `pay` is absent" can never apply
   after merging. The old flags are accepted, so stored overrides stay
   valid, but ignored. No code ever acted on them (ADR-0015).

## Consequences

- **Positive:**
  - People can say how long they'll be away, and managers see it
    against what actually happened.
  - HR controls the list, names, pay rules and limits without a release.
  - Paid and unpaid break time finally has a figure, ready for the
    greytHR export.
  - It closes the unchecked-`break_kind` gap.
- **Negative:**
  - **A rename changes how past breaks are labelled,** because history
    shows the current label (ids are stable). It's acceptable because
    renames should be rare; the policy audit records them.
  - **Managers seeing the type** means a pattern of Personal breaks is
    visible. That's the owner's choice. The privacy notice needs a line
    saying break types and planned times are visible to the person's
    manager.
  - **Old apps (0.1.x before this) show only Bio and Meal.** With
    auto-update (ADR-0022) that settles within a day of a release.
  - The pay rule applied depends on the policy version at the break's
    start, which puts a version lookup into the day totals.

## Alternatives considered

- **Custom types created by HR.** Rejected: there's no stable meaning
  for payroll, and the labels would drift into free text inside events.
  Renaming the fixed types covers the need.
- **Prayer and Medical types.** Rejected by the owner: they record
  religion and health.
- **A reason note on personal breaks.** Rejected: free text about
  someone's private life (invariant 1, and the same sensitivity).
- **Managers see only "Break" and its length.** Rejected by the owner.
- **Enforce the limit (auto-end the break).** Rejected: the limit is a
  reminder and a pay boundary, never an automatic action (as ADR-0013).

## Delivery (small PRs)

1. **Schemas and backend:**
   - the event schema and ingest check;
   - the policy schema;
   - Training;
   - paid/unpaid day totals with tests.
2. **Desktop core:** new `BreakKind` values, policy parsing,
   `planned_minutes`, the "Back yet?" reminder.
3. **Desktop UI:** the Break menu, "Back in?", Training, the Settings
   Breaks section, planned vs. actual on the day view.
4. **Docs:** the privacy notice line, and `docs/policy/idle-policy-defaults.md`.
