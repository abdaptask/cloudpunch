# ADR-0033 — A web dashboard at cloudpunch.aptask.com for managers, HR and admins

- **Status:** Accepted (2026-10-08, the owner chose the recommended answer to each open question)
- **Date:** 2026-10-08
- **Deciders:** Abdulla Sheikh (project owner), Architecture (Claude)
- **Builds on:** ADR-0002 §4 (the `CloudPunch Web` SPA registration,
  planned but not created), ADR-0019 (pilot VM behind a Cloudflare
  Tunnel), ADR-0025 (Team views), ADR-0029/0032 (connections), ADR-0030
  (corrections).
- **Confidence:** High on the shape (the server side exists and is
  already role-checked). Medium on the effort estimate for reusing the
  desktop screens in a browser, until PR 1 proves it.

## Context

The owner (2026-10-08):

> "if managers dont want to get this installed on their pc.. can we
> have a report dashboard created for them based on their credentials
> at cloudpunch.aptask.com website?"

Facts that shape the decision:

- Every manager view the desktop app has (Team, a person's day, the
  last 30 days, exceptions, corrections, where people connect from) is
  already a `/v1` API call that validates the Entra token and checks
  role and reporting line on every request (invariants 5 and 6). The
  desktop app is only a client of those calls.
- The desktop screens are React and reach the server through one `api`
  object (`apps/desktop/src/api.ts`, Tauri `invoke`). They don't call
  Tauri anywhere else that matters for the Team views.
- ADR-0002 §4 already planned a **CloudPunch Web** SPA registration
  (MSAL.js, PKCE, no secret, single tenant, `api.access`). It was never
  created (step C deferred). `apps/web/` exists as an empty folder.
- cloudpunch.aptask.com is served by the backend through the Cloudflare
  Tunnel. Cloudflare Access sits only on `/download*`; `/v1` can't be
  behind Access because the desktop app calls it directly.

## Decision

### 1. What it is

A browser dashboard at **https://cloudpunch.aptask.com/app/** for
the roles that can already see other people's time: **Manager** (their
reporting line) and **HR** (`team.timeline.read`, unchanged). No role
gains a capability. Administrators and Auditors see it only if they
also hold one of those roles, exactly as in the desktop Team tab. It is a **viewer for other people's time**, not a time tracker:
nobody clocks in from a browser (tracking needs the desktop agent).

- A manager who doesn't track their own time never installs anything.
  They still need an employee record in People (that's how reporting
  lines find their team), and they should have **no shift** assigned,
  or their own manager's Team view will show them "Not clocked in".
- A manager who does track their own time keeps the desktop app for
  that and can use either for their team.
- Anyone without `team.timeline.read` who signs in sees "CloudPunch
  on the web is for managers; use the desktop app" and nothing else.

### 2. Pages (first release)

1. **Team**: who's in, on a break, idle, on a call or not clocked in
   now, with today's worked time; the exceptions list.
2. **A person**: the same summary-first screen as desktop 0.1.21:
   Today card, Earlier (30 days), corrections on each day, and where
   they connect from (Managers and Administrators only, as in
   ADR-0029 §5).
3. **Corrections queue**: corrections waiting for this manager (see
   open question 1 for whether they can approve here).

Settings, People, Shifts and the other admin screens stay desktop-only
in this ADR. Adding them later is a follow-up, not a redesign.

### 3. Sign-in and tokens

- MSAL.js (`@azure/msal-browser`), redirect flow, PKCE, the
  `CloudPunch Web` registration from ADR-0002 §4, scope
  `api://63bca00e-…/api.access`.
- **Redirect URI:** `https://cloudpunch.aptask.com/app/` (and
  `http://localhost:5173/app/` for development). This replaces the
  ADR-0002 placeholders (`/auth/callback`).
- The access token is held **in memory only**; MSAL's own short-lived
  redirect state uses `sessionStorage`. A reload renews silently from
  the Entra session.
- **No server session or cookie.** The API stays bearer-token-only, as
  for the desktop. This drops ADR-0002's "session ID in an HttpOnly
  cookie", which assumed a backend-for-frontend that we don't need.
- The server ignores anything the browser says about roles: the
  `roles` claim in the API token is the authority, per request
  (invariant 6). Nothing about authorisation changes on the server.

### 4. Hosting

- The backend serves the built web app from `/app/` (static files,
  same origin as `/v1`), so there is **no CORS** to open and no second
  server or domain.
- Strict CSP on `/app/`: scripts and styles from self only;
  `connect-src` self and `https://login.microsoftonline.com`.
- **Cloudflare Access on `/app*` too**, using the ApTask Entra login,
  as a second gate in front of the page (the data is still protected
  by the API token either way). See open question 3.
- The landing page gets a **Manager sign-in** link next to the
  download buttons.

### 5. Reusing the desktop screens

`apps/web` renders the desktop's Team, person and corrections
components with a **browser implementation of the same `api` object**
(`fetch` to `/v1` with the MSAL token), instead of rewriting them. Any
shared component that turns out to depend on Tauri gets that piece
passed in as a prop. If this proves messy in PR 1, the fallback is to
move the shared screens into `packages/` (a refactor PR of its own).

### 6. Audit

Unchanged: the server already audits `day_viewed` and connection views
whichever client asks.

## Rollout (small PRs)

0. **Owner, Entra (≈5 min):** create `CloudPunch Web` per ADR-0002 §4
   with the redirect URIs above; grant `api.access` with admin consent;
   send me its client ID. Optional: Cloudflare Access app for
   `cloudpunch.aptask.com/app*`.
1. **Web shell:** Vite + React app in `apps/web`, MSAL sign-in, the
   browser `api` object, the backend serving `/app/`, the role gate,
   the landing link. CI builds and tests it.
2. **Team + a person** (read-only) using the desktop components.
3. **Corrections** (view, or view + approve per open question 1).

Each is a backend deploy; none needs a migration. The desktop app is
untouched.

## Consequences

- Managers can see their team from any browser, with nothing installed.
- One more way in to the same data, but no new permissions: the web
  can only do what the same person's token already allows through the
  desktop app.
- A second client to keep working (the shared components keep the
  cost down; a change to a Team screen shows up in both).
- Browsers are a broader attack surface than the desktop app (XSS,
  shared computers). Mitigated by the strict CSP, tokens in memory only,
  no cookies, Cloudflare Access, and Entra Conditional Access applying
  to the web sign-in.

## Alternatives considered

- **Require managers to install the desktop app.** Status quo; the
  owner wants an option for managers who won't install it.
- **A separate reporting site** (e.g. Power BI or a BI tool on a
  database copy). More moving parts, a second permission model to keep
  in step with reporting lines, and data no longer live. Rejected.
- **Server-rendered pages with a session cookie.** Works, but means a
  cookie session, CSRF handling and a second authorisation path on the
  server. The SPA reuses the existing bearer-token API unchanged.
  Rejected.
- **Emailed daily reports.** Useful later as an addition, not a
  replacement: no drill-down, and it pushes personal data into
  mailboxes.

## Owner's answers (2026-10-08)

1. **Approvals:** view-only in the first release; approving from the
   browser is a later follow-up.
2. **Who gets it:** Managers and HR, as in the desktop Team tab.
3. **Cloudflare Access on `/app*`:** yes, as a second gate.

`CloudPunch Web` client ID: `c0d42233-0f69-4379-9956-f6f7e48a5278`
(not a secret).
