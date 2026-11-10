# ADR-0054 — People table: one list with a Status filter, badges and action icons

- **Status:** Accepted (2026-11-10, owner decision)
- **Deciders:** Abdulla Sheikh (owner)
- **Relates to:** ADR-0038 §3 (People table), ADR-0052 (Deactivate),
  ADR-0053 (deactivated people, Reactivate)
- **Supersedes:** the separate "Deactivated" view of ADR-0053 §1. Its
  panel, history and Reactivate are unchanged.
- **Confidence:** High. This is a layout change on data the console already
  loads, and it is covered by component and browser tests at desktop and
  phone widths.

## Context

The owner shared screenshots of ApTask's own "Team Members" screen and asked
for CloudPunch's People to match it:

- a search box with reset and reload buttons;
- dropdown filters for role, status and manager, plus tick-box filters;
- blue names, coloured role badges and green or red status badges;
- a row of action icons with tooltips.

The owner's answers: inactive people go in the same table; managers instead
of a Teams column; match the look.

## Decision

1. **One table, Active by default.** The Status dropdown offers All, Active
   or Inactive. Deactivated records (ADR-0053) are rows marked with a red
   **Inactive** badge. Their tick boxes are disabled, so bulk changes never
   include them. Opening one shows the deactivated panel (ADR-0053).
2. **Toolbar.** "People" with "N of M people", a search box, **Reset filters**
   and **Reload**. Then the dropdowns (All roles, status, All managers) and
   the tick-box filters: **Managers only**, **No manager**, **No shift** and
   **No role**, each showing a count. These replace the "needs attention"
   chips.
3. **Columns.** Tick box, **Name** (blue), **Email**, **Manager** (an outlined
   badge where the screenshot has Teams), **Roles** (coloured badges:
   Administrator purple, HR teal, Manager blue, Payroll amber, Auditor
   slate, Employee outlined), **Shift** and **Office** (as before),
   **Status** (Active or Inactive), and **Actions**. A ⚠ next to the status
   lists what needs doing (no manager, no shift…) in its tooltip. While a
   panel is open, Email, Shift and Office are hidden so that Status and
   Actions stay in view.
4. **Actions.** Each action is an icon with a tooltip, and each opens the
   person's panel at the matching part:
   - **Edit** (or **View** for an inactive person);
   - **Roles** (key);
   - **History** (clock): time history, now also for active people, a year
     back (ADR-0053 §4), plus their changes;
   - **Welcome email**;
   - **Deactivate** (orange person-✕), which opens straight at the
     confirmation;
   - for inactive people, **Reactivate** (green person-✓).

   Nothing is changed in one click: every change still goes through the
   panel's confirmation and reason.
5. **Left out.** There is no Delete: CloudPunch never deletes a person, and
   Deactivate takes its place. TelNyx, Exempt and RBAC role have no
   counterpart in CloudPunch.
6. **No new packages.** The icons are inline SVG drawn in
   `admin/icons.tsx`, and the colours are defined for both light and dark
   mode.

## Consequences

- The desktop console needs 0.1.50. The web dashboard changes when the
  server is deployed.
- The table is wider than before. It scrolls sideways inside its own box,
  never the page.

## Alternatives considered

- **Keep the separate Deactivated view.** The owner chose one list, which
  matches their other tool.
- **Pull in an icon library.** Not needed for nine icons, and it would add
  a supply-chain dependency.
