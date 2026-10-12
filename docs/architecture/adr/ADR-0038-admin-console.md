# ADR-0038 — An admin console: one People table, bulk changes, named shifts, and Rules by section

- **Status:** Proposed (2026-10-12; the owner chose "both", named
  shifts and all four bulk actions; see "Decided so far")
- **Date:** 2026-10-12
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0020 (People and roles through Graph OBO),
  ADR-0021 (welcome email), ADR-0025 (reporting lines), ADR-0028 §4
  (active machine), ADR-0031 (shifts), ADR-0033 (web dashboard),
  ADR-0018 §5 / ADR-0015 (settings and policy), ADR-0037 (holidays).
- **Amends:** ADR-0033 §1–§2 (the web app is no longer for managers
  only, and gains the admin screens it set aside as a follow-up).
- **Confidence:** High on the layout and the shared components (the
  web already renders the desktop's Team screen). Medium on two things
  not yet tried: role changes through Graph from a web sign-in (§7)
  and a second, wide desktop window (§2).

## Context

The owner, reviewing People and Rules on 2026-10-12: "the roles tab is
huge.. so is the reporting lines and shifts.. i have to keep scrolling
and by the time i forget what i was looking for", and asked to pick a
manager by name, to assign several people at once, to do the same for
shifts, and to look like an enterprise app across the app.

What the screens are today:

- **The desktop window is 420 × 640 and can't be resized.** Every admin
  screen lives in it, one column wide.
- **People is four lists stacked** (`App.tsx`): the directory search
  and the role editor, everyone with a role, **Reporting lines** (one
  manager dropdown per person), **Shifts** (one row and an inline
  editor per person), then **Holidays**. With 50 people that is about
  150 rows before Holidays.
- **One person at a time.** Roles, manager and welcome email are
  per person. Shifts have "Copy to…" (ADR-0031), which the screen runs
  as one call per person.
- **The manager dropdown lists every candidate**, with no search.
- **Warnings sit under each row** ("has no CloudPunch role", "doesn't
  have the Manager role yet"), so finding them means scrolling.
- **Rules is seven boxes and one Save at the bottom.** For a
  department, nothing shows which values differ from the company's.
  "Saved" or an error appears at the bottom, out of view.
- **The rollout is about 50 more people** (ADR-0037). Setting up
  managers and shifts one by one is the slow part.

## Decision

### 1. One admin console, built once, shown in two places

The admin screens become an **admin console**: a left sidebar and a
wide content area. It is one set of React components in
`apps/desktop/src/admin/`, as the web already imports the desktop's
Team and Corrections screens (ADR-0033).

Sidebar (each item only for the roles that can use it today):

| Section | Who | Today |
| --- | --- | --- |
| **People** | Administrators, HR | People + Reporting lines |
| **Shifts** | Administrators | Shifts |
| **Holidays** | Administrators, HR | Holidays |
| **Rules** | Administrators, HR (a department) | Rules |
| **Computers** | Administrators, Auditors | Versions |
| **Connections** | Administrators | Connections |

No role gains a capability. The server checks every request as now
(invariants 5 and 6); the sidebar only hides what would be refused.

### 2. Where it opens

- **Web:** `https://cloudpunch.aptask.com/app/admin/`. The web app's
  gate widens from "can see a team" to "can see a team **or** has any
  admin capability". Someone with neither still sees the "use the
  desktop app" page.
- **Desktop:** Settings opens a **separate admin window**, 1100 × 720,
  resizable, minimum 900 × 600, built like the prompt window
  (`WebviewWindowBuilder`). The main 420-wide window stays the clock.
  Closing the admin window changes nothing else.
- Both are the same components, so a fix lands in both. A desktop
  change still needs a desktop release (the web picks it up on deploy).

### 3. People: one table

One table replaces the role list, Reporting lines and the per-person
shift rows.

- **Columns:** Name (with email), Roles (chips), Manager, Shift,
  Status. Sortable; the header stays put while scrolling; 50 rows a
  page.
- **Search** by name or email, and **filters**: role, manager,
  "No manager", "No shift", "No role".
- **Needs attention**, as counts above the table, each one a filter:
  "3 without a manager", "2 without a shift", "1 manager without the
  Manager role", "1 with a record but no role". These replace the notes
  under each row today.
- **Add person** searches the company directory (as today) and opens
  the panel for the new person.
- **The person panel** opens on the right when a row is clicked, so
  the table keeps its place: roles, manager (§4), shift, active
  machine (Administrators, ADR-0028 §4), welcome email, and a short
  history of changes to them (phase 8).

### 4. Picking a manager by name

A **type-to-search picker** replaces the dropdown: type two letters,
pick from the matches. It offers the same people as today (the Manager
or HR role, ADR-0025 as amended) plus "No manager". A manager without
the Manager role is still shown with "Give them the Manager role".

### 5. Bulk changes

Ticking rows (or "Select all N matching") shows a **bulk bar**:

**Set manager · Set shift · Add role · Remove role · Send welcome
email**

- Every bulk action shows a **preview before saving**: "This changes 12
  people: 9 get Priya as manager, 3 already have her", with the reason
  field. Nothing is saved until **Apply**.
- **At most 200 people per action.**
- Each person still gets their **own `audit_log` row**, with the shared
  reason and a shared batch id, so the audit trail reads as it does
  today.
- Each request carries an **idempotency key** (invariant 4). A new
  append-only table `admin_bulk_request` (key, actor, kind, a hash of
  the request, the result, when) keeps the answer; a retry with the
  same key returns it and changes nothing.

How each one runs:

| Action | Endpoint | All or nothing? |
| --- | --- | --- |
| Set manager | `PUT /v1/admin/employees/bulk/manager` | **Yes**, one transaction. Any loop or missing person refuses the whole batch and names who. |
| Set shift | `PUT /v1/admin/employees/bulk/shift` | **Yes**, one transaction, from a chosen date (§6). |
| Add / remove role | `POST /v1/admin/people/bulk/roles` | **No.** Graph is one call per person, so the answer lists each person: done, or why not. Rerunning the same request skips those already done. |
| Welcome email | `POST /v1/admin/people/bulk/welcome` | **No**, per person; the 10-minute gap per person (ADR-0021) still applies and shows as "sent recently". |

The rules for one person still hold for many: HR may give or remove
Employee and Manager only (ADR-0020 §3); no one removes their own
Administrator role; CloudPunch keeps at least one Administrator,
checked against the result of the whole batch.

### 6. Named shifts

- An Administrator sets up **named shifts** once on the Shifts page:
  "India day · Mon–Fri 09:00–18:00 IST", "US Eastern · Mon–Fri
  08:00–17:00 ET". A name, days, start, end and zone, as a shift has
  today.
- People get a shift **by name**, singly in the panel or in bulk, from
  a date (today by default). A one-off pattern is still possible
  ("Custom").
- **Editing a named shift changes it for everyone on it**, from a date
  the Administrator picks, after a preview: "This changes the shift of
  14 people from 19 Oct".
- **Storage (migration):** append-only like every CloudPunch history
  table.
  - `shift_template` (id, name) and `shift_template_version` (template,
    days, start, end, zone, effective_from, by, at). The latest version
    on or before a date applies.
  - `shift_assignment` gains a nullable `template_id`. A row with one
    follows the template; a row without one is today's custom pattern.
    Existing rows are untouched and stay custom.
  - Retiring a named shift is a new version marking it retired; people
    on it keep it until moved, and the Shifts page lists them.
- **Everything that reads a shift reads the resolved one:**
  `GET /v1/me/shift`, Team, the shift-start emails and the regular
  late starters (ADR-0037). One function resolves a shift for a person
  and date, and all of them call it.
- The Shifts page lists each named shift with how many people are on
  it, and a "People on a custom shift" count.

### 7. Role changes from the web

Role changes use Graph on behalf of the signed-in admin (ADR-0020 §2).
The web's API token has the same audience as the desktop's
(`api://63bca00e-…/api.access`), so the server's exchange should work
unchanged. This is checked in phase 3 before the web shows role
editing; until it works, the web shows roles read-only with "Change
roles in the desktop app".

### 8. Rules by section

- **A section menu** on the left: Idle, Clock-in popup, Long days,
  Breaks, Away, Connection location, Shift-start emails. One section
  shows at a time.
- **Company / department** switch at the top. On a department, each
  value it changes shows **Overridden** and the company value, with
  **Reset to company value**.
- **Breaks as a table:** Type | On | Name | Pay | Limit.
- **A save bar that stays on screen:** "3 unsaved changes · Why ·
  Save · Discard", across sections. Leaving with unsaved changes
  asks first.
- **What changed:** a list of earlier saves (who, when, why, which
  values), read from `audit_log` (phase 8).
- The server, the policy shape and the save call are unchanged.

### 9. The same patterns elsewhere

- **Holidays, Computers, Connections:** the same table (search,
  filters, sort). Holidays gains **paste a list** ("26 Jan, Republic
  Day" per line) with a preview before saving.
- **Messages:** "Saved" and errors appear as a short notice at the
  top of the content area instead of at the bottom of a long page.
  Destructive actions (Remove role, Sign out of this machine) confirm
  in a dialog.
- **Shared components**, so every screen looks and behaves the same:
  `DataTable`, `SidePanel`, `BulkBar`, `PersonPicker`, `SaveBar`,
  `Notice`, `ConfirmDialog`. No new UI library; built on the theme
  and `Button` we have.
- **Team** stays as it is in this ADR. It can move onto `DataTable`
  later.

### 10. Privacy (invariant 1)

Nothing new is collected. The console shows what these screens show
today, to the same roles. Bulk requests carry ids, names of shifts and
a reason.

## Plan

One PR per phase; each desktop phase is a release (bump, build,
publish Win + Mac).

1. This ADR.
2. Admin console shell: shared components, the desktop admin window,
   the web `/app/admin/` route and the wider gate. Today's screens move
   in unchanged.
3. **People table and person panel**, on today's endpoints; the
   manager picker. Check Graph OBO from the web (§7).
4. **Bulk:** migration (`admin_bulk_request`), the manager, role and
   welcome endpoints, and the bulk bar.
5. **Named shifts:** migration, template endpoints, bulk shift, the
   Shifts page, one shift resolver used by `/v1/me/shift`, Team and the
   alerts.
6. **Rules** by section, overrides and the save bar.
7. **Holidays, Computers, Connections** on the table; paste holidays.
8. **Change history** (a read endpoint over `audit_log` for the panel
   and Rules), and the old admin screens leave the 420-wide window.

## Consequences

- People, managers and shifts for 50 people become a few bulk actions
  instead of 150 rows.
- Admins can work from a browser, with nothing installed.
- Two migrations (bulk requests; named shifts), five new endpoints,
  and one change to how a shift is read. The shift change touches the
  popup and the alerts, so it gets its own tests against today's
  behaviour.
- A bulk mistake reaches many people. The preview, the 200 cap, the
  per-person audit and all-or-nothing for managers and shifts limit it.
- The desktop gains a second window to maintain.
- More screens in the web app means more to keep in step; sharing the
  components is what keeps that cheap.

## Alternatives considered

- **Web only.** Simplest, but the owner wants it in the desktop too.
- **Only a bigger desktop window.** The main window is sized to its
  content and pinned near the tray; growing it to 1100 wide for
  Settings and back would jump on screen. A separate window doesn't.
- **Keep the lists, add collapsing.** Less scrolling, but still no
  search, filters or bulk.
- **Bulk in the screen only (as "Copy to…").** No new endpoints, but a
  half-finished batch on a lost connection, and no idempotency.
- **Per-person shifts only, no names.** No migration, but changing
  "India day" means finding everyone on it.

## Decided so far (2026-10-12, the owner)

1. **Where:** both, the desktop and the web, from the same components.
2. **Named shifts:** yes.
3. **Bulk actions in the first release:** set manager, set shift, add
   or remove role, send welcome email.

## Open questions

1. **Editing a named shift moves everyone on it** (§6). Proposed: yes,
   from a chosen date, after a preview. The alternative is that edits
   affect only people assigned afterwards.
2. **HR and bulk roles.** Proposed: HR can bulk add or remove Employee
   and Manager, as they can one at a time.
3. **The old screens in the small window.** Proposed: removed in phase
   8, once the console has everything.
