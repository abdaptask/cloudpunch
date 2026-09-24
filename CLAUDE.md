# CloudPunch — Contributor guidance for AI assistants and engineers

This file captures the durable rules for working on CloudPunch. Anything not
here should be looked up in `docs/`.

## Product summary

Employee time and attendance for ApTask remote workers. Windows and macOS
desktop agent + web dashboard + Node.js API. India-only workforce for now.
Microsoft Entra ID SSO. greytHR as system of record (integration deferred
until API access is confirmed). AWS `ap-south-1` primary region.

## Non-negotiable invariants — enforced by tests

1. **No content capture.** No keystroke content, no screenshots, no clipboard,
   no mic audio, no webcam, no filenames, no browser history, no per-app usage.
   OS state metadata only. **One named exception (ADR-0012):** during a
   detected call, the _category_ of the app holding the microphone
   (`teams` / `zoom` / `other`) from a fixed allowlist — never the
   app name, path, window title, or audio. Enforced by
   `test/invariants/no-content-capture.ts` (not yet implemented — tracked
   under the CI item).
2. **Immutable event history.** `time_event` table is append-only. Any code
   path that issues `UPDATE` or `DELETE` on `time_event` must be rejected in
   CI.
3. **Manager approval gate.** Attendance must not be exported to greytHR
   without a corresponding `approval` row with status `APPROVED` and a
   locked `timesheet_version`.
4. **Idempotent ingest and export.** Every event and every export carries an
   idempotency key. Duplicate submissions are no-ops.
5. **Least privilege.** No user role has permission it does not require.
   `Employee` cannot read another employee's data. `Manager` sees only
   assigned team members. `Auditor` is read-only.
6. **Entra token validation server-side.** Never trust client-supplied role.
   The `roles` claim is authoritative and re-validated per request.

## Working rules (from project owner)

- Do not change code, install packages, alter infrastructure, run migrations,
  or commit anything without explicit approval.
- Do not overwrite working functionality.
- Reuse existing components and conventions wherever practical.
- Identify assumptions, risks, security concerns, and missing requirements.
- Do not claim more than 95% confidence about code that has not been verified.
- After approval, work in small, testable phases and explain each material
  change.
- Never commit or push changes without explicit approval.
- Maintain the changelog and update relevant documentation.

## ADR discipline

- Every architecturally material decision gets an ADR under
  `docs/architecture/adr/ADR-NNNN-slug.md` using the Nygard template
  (context, decision, consequences, alternatives, confidence).
- ADRs are numbered monotonically and never renumbered.
- Superseding an ADR: write a new ADR that references the old one; update
  the old one's status header to `Superseded by ADR-XXXX` but do not delete
  its content.
- ADRs are code artefacts. Changes require review like any other PR.

## Coding conventions (locked as of Phase 0)

- **Language:** TypeScript (backend + web + shared), Rust (desktop core).
- **Formatting:** Prettier for TS, `rustfmt` for Rust, `.editorconfig` for
  everything else. No manual formatting bikeshedding.
- **Linting:** ESLint (typescript-eslint recommended-type-checked) + Clippy
  for Rust (deny warnings in CI).
- **Testing:** Vitest for TS unit, Playwright for web E2E, `cargo test` for
  Rust unit, a bespoke harness for Windows/macOS platform tests.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`, `test:`). Include an ADR reference in the body when relevant.
- **Branching:** `main` is protected. Feature branches: `phase-N/short-slug`.
- **PRs:** small, focused, one concern per PR. Every PR updates
  `CHANGELOG.md` under `## [Unreleased]`.

## What to do when uncertain

- Re-read the relevant ADR. If none exists, propose one.
- Ask the project owner. Never fabricate answers or guess at APIs.
- Prefer surfacing a gap over silently working around it.
