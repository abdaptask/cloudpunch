# ADR-0002 — Microsoft Entra ID app registrations, App Roles, and SSO flows

- **Status:** Accepted (Phase 0)
- **Date:** 2026-09-23
- **Deciders:** Abdulla Sheikh (project owner and Entra Global Admin), Architecture (Claude)
- **Confidence:** High on the structure; medium on final choice of Application
  ID URI format (see §3.2) — safe fallback documented.

## Context

CloudPunch must authenticate:

- The Windows and macOS desktop agent
- The web dashboard (admin, manager, HR, payroll, auditor, employee)
- The backend API (server-side token validation)

against a **single-tenant** Microsoft Entra ID registration in `aptask.com`.
The tenant already exists; the project owner is Global Administrator.

Constraints locked in prior conversations and by regulatory posture:

- OAuth 2.0 Authorization Code Flow with **PKCE** for all clients.
- **No client secrets embedded in the desktop or web SPA**.
- Backend API must independently validate `iss`, `aud`, `tid`, signature,
  `exp`, and required App Role claim on every request.
- Authorization derived from **App Roles** on the API registration — not from
  group membership, not from client-supplied claims.
- Server-side session revocation is possible even if the Entra token is
  still valid on paper.

## Decision

### 1. Three app registrations in the `aptask.com` tenant

| # | Display name | Type | Purpose |
|---|---|---|---|
| 1 | **`CloudPunch API`** | Web / API (confidential) | Resource server. Exposes the delegated scope and defines the six App Roles. No user sign-in UI. |
| 2 | **`CloudPunch Desktop`** | Public client (Mobile and desktop applications) | Windows + macOS agent. PKCE via loopback. No secret. |
| 3 | **`CloudPunch Web`** | Single-page application (SPA) | Browser dashboard. PKCE via MSAL.js. No secret. |

**Environment isolation:** we use **one set of registrations per tenant** and
distinguish environments through **redirect URIs, hostnames, and App Role
assignments**. If defence-in-depth later demands stricter isolation
(dev tokens must not validate against prod API), split into six registrations
(dev + prod pair for each of API/Desktop/Web). This split is a mechanical
future migration — no design impact on code today.

### 2. `CloudPunch API` — resource registration

- **Supported account types:** *Accounts in this organizational directory only
  (`aptask.com` — single tenant).*
- **Application ID URI:** `api://<CloudPunch API clientId>` at creation.
  Optionally re-point to `api://cloudpunch.aptask.com` later if the DNS
  subdomain is verified for the tenant.
- **Token settings:**
  - `accessTokenAcceptedVersion`: `2`
  - `signInAudience`: `AzureADMyOrg`
  - `groupMembershipClaims`: `null` — we do not use group claims.
- **Expose an API — scope (delegated):**

  | Name | `api.access` |
  |---|---|
  | Who can consent | Admins only |
  | Admin consent display name | "Access CloudPunch API" |
  | Admin consent description | "Allows the calling application to call the CloudPunch API on behalf of the signed-in user. Authorization is enforced by CloudPunch based on the user's assigned App Roles." |
  | State | Enabled |

  Rationale: one delegated scope + fine-grained authorization via App Roles is
  cleaner than modelling every capability as a separate scope. If a future
  service-to-service integration (for example a payroll sync worker) needs
  application-only access, add an *application permission* on the API app and
  grant it as an App Role for applications.

- **App Roles** (all six, on the API registration; assignable to
  **Users/Groups**; `Requires assignment` = **Yes**):

  | Role display name | Value (stable string in token `roles` claim) | Allowed for |
  |---|---|---|
  | Employee | `Employee` | Users, Groups |
  | Manager | `Manager` | Users, Groups |
  | HR | `HR` | Users, Groups |
  | Administrator | `Administrator` | Users, Groups |
  | Payroll | `Payroll` | Users, Groups |
  | Auditor | `Auditor` | Users, Groups |

  App Role values are **stable identifiers in code**. Never rename them — add
  a new role and deprecate the old one instead. Every backend authorization
  check imports the string constants from `packages/shared/src/roles.ts`.

- **Assignment enforcement:** **Requires assignment: Yes** on the enterprise
  application object. Users without an assignment cannot obtain a token —
  this is our defence against ex-employees whose Entra account still exists
  but is no longer assigned. Assignments are the primary access-control gate.

- **Manifest fields to lock (portal → Manifest tab):**
  ```jsonc
  {
    "accessTokenAcceptedVersion": 2,
    "signInAudience": "AzureADMyOrg",
    "groupMembershipClaims": null,
    "oauth2RequirePostResponse": false,
    "publicClient": { "redirectUris": [] },
    "web": { "redirectUris": [] },
    "spa":  { "redirectUris": [] }
  }
  ```
  (The `appRoles` array is edited via the App Roles pane — do not hand-edit
  the manifest for that; use the UI so audit logs record who added each role.)

- **Optional token claims** — enable via **Token configuration** pane:
  - `email` (id token + access token)
  - `preferred_username` (id token + access token)
  - `given_name`, `family_name` (id token)
  - `oid` and `tid` are always present.
  - `roles` is emitted automatically once an App Role is assigned.

### 3. `CloudPunch Desktop` — public client (Windows + macOS)

- **Supported account types:** Single tenant.
- **Redirect URIs (Public client / native):**
  - `http://localhost` — Entra allows any port after this base for public
    clients; the agent binds an ephemeral loopback port at sign-in time.
  - `msal<clientId>://auth` — reserved fallback for a custom URL scheme
    approach if loopback is ever blocked on a corporate network.
- **Allow public client flows:** Yes (`allowPublicClient: true` in manifest).
- **API permissions (delegated):**
  - `CloudPunch API` → `api.access`
  - Microsoft Graph → `openid`, `profile`, `email`, `offline_access`
  (`offline_access` is required to receive the refresh token on desktop.)
- **Grant admin consent** for the tenant so no user sees a consent screen.
- **Manifest:**
  ```jsonc
  {
    "allowPublicClient": true,
    "signInAudience": "AzureADMyOrg",
    "publicClient": {
      "redirectUris": [
        "http://localhost",
        "msal<PLACEHOLDER-desktop-clientId>://auth"
      ]
    }
  }
  ```

### 4. `CloudPunch Web` — single-page application

- **Supported account types:** Single tenant.
- **Redirect URIs (Single-page application / spa):**
  - `http://localhost:5173/auth/callback` (Vite dev server)
  - `http://localhost:5173/` (silent-refresh iframe target)
  - `https://cloudpunch.aptask.com/auth/callback` — production placeholder;
    replace with the final hostname during Phase 7 rollout.
  - `https://cloudpunch.aptask.com/` — silent-refresh iframe target.
- **Front-channel logout URL:** `https://cloudpunch.aptask.com/auth/logout`
  (placeholder; enable during Phase 3 when session UI lands).
- **API permissions (delegated):**
  - `CloudPunch API` → `api.access`
  - Microsoft Graph → `openid`, `profile`, `email`
  (No `offline_access` — browser SPA silently renews via MSAL.js iframe.)
- **Grant admin consent** for the tenant.
- **Manifest:**
  ```jsonc
  {
    "signInAudience": "AzureADMyOrg",
    "spa": {
      "redirectUris": [
        "http://localhost:5173/auth/callback",
        "http://localhost:5173/",
        "https://cloudpunch.aptask.com/auth/callback",
        "https://cloudpunch.aptask.com/"
      ]
    }
  }
  ```

### 5. Sign-in flows

**Desktop (Windows + macOS):**

1. Agent generates PKCE `code_verifier` (43–128 characters, high entropy) and
   `code_challenge = SHA256(code_verifier)` base64url-encoded.
2. Agent starts a loopback HTTP listener on `127.0.0.1:<ephemeral-port>`.
3. Agent opens the **system browser** to:
   ```
   https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/authorize
     ?client_id=<Desktop clientId>
     &response_type=code
     &redirect_uri=http://localhost:<port>
     &response_mode=query
     &scope=openid+profile+email+offline_access+api://<API clientId>/api.access
     &code_challenge=<code_challenge>
     &code_challenge_method=S256
     &prompt=select_account
     &state=<crypto-random>
   ```
4. User authenticates (MFA, Conditional Access applied by Entra).
5. Browser redirects to `http://localhost:<port>?code=...&state=...`.
6. Agent validates `state`, POSTs to `/oauth2/v2.0/token` with `code` +
   `code_verifier`, receives `id_token`, `access_token`, `refresh_token`.
7. Agent validates the ID token locally as a sanity check, then hands the
   `access_token` to the backend on the next API call.
8. `refresh_token` stored in **Windows Credential Manager**
   (`CRED_TYPE_GENERIC`, DPAPI-encrypted) or **macOS Keychain**
   (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, `service =
   com.cloudpunch.msal`).
9. Silent refresh in the background before expiry.
10. Logout: revoke refresh token, delete Keychain/Credential Manager entry,
    open `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/logout`.

**Web dashboard:**

- MSAL.js v3, `PublicClientApplication`, redirect flow (safer than popup for
  Conditional Access).
- Silent renewal via hidden iframe.
- Session ID is stored in an HttpOnly + Secure + SameSite=Strict cookie; the
  access token is held only in memory (never `localStorage`).

**Backend token validation (every request, before authorization):**

1. Fetch JWKS from
   `https://login.microsoftonline.com/<tenantId>/discovery/v2.0/keys`
   (cache per key, 24h TTL, refresh on `kid` miss).
2. Validate `iss = https://login.microsoftonline.com/<tenantId>/v2.0`.
3. Validate `aud = <CloudPunch API clientId>` (or Application ID URI).
4. Validate `tid = <tenantId>`.
5. Validate signature against JWKS `kid`.
6. Validate `exp` and `nbf` with a 60-second skew window.
7. Validate `scp` contains `api.access`.
8. Read `roles` claim — this is the authoritative role set.
9. Check the request path/method against the **per-role permission matrix**
   in `packages/shared/src/permissions.ts`.
10. Emit an `audit_log` row with actor `oid`, `correlationId`, roles at time
    of request.

### 6. App Role assignment strategy

- **Default:** every employee added via CloudPunch Admin (or synced from
  greytHR when enabled) receives the **`Employee`** App Role automatically.
  The CloudPunch backend calls Microsoft Graph
  `POST /users/{oid}/appRoleAssignments` to grant the role.
- **Manager / HR / Administrator / Payroll / Auditor** roles are additive and
  assigned by an existing Administrator via the CloudPunch admin UI, which
  behind the scenes uses Graph.
- **Removal:** deleting an employee in CloudPunch Admin (or termination sync
  from greytHR) revokes their App Role assignments. Their Entra identity
  persists; only CloudPunch access is removed.
- **Emergency break-glass:** a dedicated cloud-only Entra account
  (name `cloudpunch-breakglass@aptask.com`) is manually assigned the
  `Administrator` App Role at tenant setup, protected by a phishing-resistant
  authentication method (FIDO2 hardware key), disabled by default (Entra
  `accountEnabled = false`), and enabled only during declared incidents.
  Sign-ins are alerted on via an Entra risk policy.

Microsoft Graph permission the backend needs (application permission, admin
consent):
- `AppRoleAssignment.ReadWrite.All`

We will minimise this later if a narrower permission becomes available.

### 7. Conditional Access alignment

The backend does **not** enforce Conditional Access — Entra does. But we
must be compatible:

- Do not use ROPC (Resource Owner Password Credentials) — blocked by CA.
- Do not use device code flow for the desktop — it works but is a poor UX
  and confuses CA device-compliance policies. Loopback PKCE is preferred.
- If CA requires a compliant device, ensure the desktop agent participates
  in **Microsoft Entra device registration** (Windows: Azure AD Join /
  Entra Joined already covers this; macOS: users register the device via
  Company Portal). CloudPunch does not require device compliance itself but
  must not fight a tenant-wide CA policy that does.

### 8. Development-tenant considerations

Per Phase 0 agreement: **no separate dev tenant.** All three registrations
live in `aptask.com`. Redirect URIs include `localhost` variants so a
developer can run the web app locally and complete an SSO flow without
touching production hostnames.

To keep production users safe during development:

- The dev backend runs against a **dev database** and validates the same
  Entra token. A token from a real employee will authenticate, but they will
  see empty/synthetic dev data.
- Developer accounts get their production App Role plus a seed **`Employee`**
  role in the dev environment via database rows (not additional Entra
  assignments).

### 9. Testing plan (for the Required Authentication Tests list)

Every item below is required to pass before Phase 1 sign-off:

| Test | Where | Notes |
|---|---|---|
| Windows Microsoft SSO | `tests/e2e-desktop/win-sso.spec.ts` | Real dev tenant, seeded user, Playwright drives Edge for the loopback callback. |
| macOS Microsoft SSO | `tests/e2e-desktop/mac-sso.spec.ts` | Same, on macOS runner. |
| Web dashboard Microsoft SSO | `tests/e2e-web/sso.spec.ts` | Playwright, real tenant, MFA-satisfied test account. |
| MFA + Conditional Access | Manual runbook | Verify CA does not block a valid sign-in. |
| Wrong tenant rejection | `tests/e2e-web/wrong-tenant.spec.ts` | Attempt with a personal Microsoft account → expect 401 with `AADSTS50020`. |
| Personal MSA rejection | Same | Backend rejects `tid ≠ aptask tenant ID`. |
| Expired token | Unit test | `exp` in past → 401. |
| Revoked assignment | Integration | Remove App Role via Graph → next token has no `roles` → 403. |
| Locally-tampered token | Unit test | Change one byte of signature → 401. |
| Missing scope | Unit test | Token lacks `api.access` → 403. |
| Client claims a role it does not have | Unit test | Server ignores client-side role, uses `roles` claim only. |
| Logout wipes tokens | Manual + unit | Keychain/Credential Manager empty after logout. |

## Consequences

### Positive

- Single tenant + App Roles is the simplest defensible design. Zero secrets on
  the client. Fully compatible with MFA, CA, and Microsoft's recommended
  desktop pattern (loopback PKCE).
- App Roles in the `roles` claim mean the hot authorization path is a claim
  read — no Graph call per request.
- Emergency break-glass is a real account managed by Entra (auditable via
  Entra sign-in logs and CloudPunch audit log) rather than a hidden password
  in the app.

### Negative

- Because the tenant is shared across environments, a developer running the
  local desktop agent can obtain a token that would validate against
  production API. Mitigation: dev API instance is on a different hostname
  and has its own database; production is not reachable from a dev machine
  without also switching the backend URL, which is a deliberate act.
- Microsoft Graph `AppRoleAssignment.ReadWrite.All` is a **tenant-wide**
  application permission. It cannot be scoped to a single app registration
  today (Microsoft limitation). We contain risk by keeping the Graph client
  library isolated in a single backend module with its own audit trail.
- The three-registration setup means every environment change (new redirect
  URI, new App Role) is a portal action. This is intentional — auditability
  wins over convenience.

### Neutral

- Silent-refresh iframe for the web SPA needs the redirect URI list to
  include the bare root (`/`). Documented above.

## Alternatives considered

### Six registrations (dev pair + prod pair for each)

Cleaner isolation. **Rejected for MVP** at ApTask's scale. Migration is
mechanical if we ever want it. Recorded here so future engineers see the
option.

### Scopes-only, no App Roles

Use `api.timesheet.approve` etc. as delegated scopes. **Rejected** — scopes
represent user consent, not user authorization; scopes are wrong for
"is this user allowed to approve timesheets." App Roles are the correct
Entra primitive for RBAC.

### Group claims for authorization

Requires Microsoft Graph lookups (groups overage above ~200 groups) and
loses stability if group names change. **Rejected** in favour of App Roles.

### Multi-tenant registration

Contradicts the single-tenant mandate. **Rejected**.

## Portal setup — the click-by-click Global Admin can follow

> These steps are the actual operational instructions. Do them in order in
> the Entra admin center (`entra.microsoft.com`).

**Step A — Create `CloudPunch API` (do this first; other apps depend on its
client ID).**

1. Entra ID → App registrations → New registration
2. Name: `CloudPunch API`
3. Supported account types: *Accounts in this organizational directory only*
4. Redirect URI: leave blank
5. Register.
6. Copy the **Application (client) ID** — this is `<CloudPunch API clientId>`.
7. Manage → Manifest → set `accessTokenAcceptedVersion` to `2` → Save.
8. Manage → Expose an API → Add a scope
   - Application ID URI: accept the default `api://<CloudPunch API clientId>`.
   - Scope name: `api.access`
   - Who can consent: **Admins only**
   - Admin consent display name: `Access CloudPunch API`
   - Admin consent description: `Allows the calling application to call the CloudPunch API on behalf of the signed-in user. Authorization is enforced by CloudPunch based on the user's assigned App Roles.`
   - State: Enabled → Save.
9. Manage → App roles → Create app role, six times, one per role in the table
   in §2 above. Value must match exactly (case-sensitive).
10. Overview → **Managed application in local directory** (the Enterprise
    App link) → Properties → **Assignment required: Yes** → Save.

**Step B — Create `CloudPunch Desktop`.**

1. App registrations → New registration
2. Name: `CloudPunch Desktop`
3. Supported account types: single tenant.
4. Redirect URI: select *Public client / native (mobile & desktop)*, value
   `http://localhost`. Register.
5. Copy the client ID.
6. Manage → Authentication → **Advanced settings → Allow public client flows: Yes** → Save.
7. Manage → API permissions → Add a permission → *My APIs* → `CloudPunch API`
   → Delegated → `api.access` → Add.
8. Add a permission → *Microsoft Graph* → Delegated → `openid`, `profile`,
   `email`, `offline_access` → Add.
9. Click **Grant admin consent for <tenant>**.

**Step C — Create `CloudPunch Web`.**

1. App registrations → New registration
2. Name: `CloudPunch Web`
3. Supported account types: single tenant.
4. Redirect URI: select *Single-page application (SPA)*, value
   `http://localhost:5173/auth/callback`. Register.
5. Copy the client ID.
6. Manage → Authentication → Add these SPA redirect URIs:
   - `http://localhost:5173/`
   - `https://cloudpunch.aptask.com/auth/callback` (placeholder — remove or
     replace when final hostname is decided)
   - `https://cloudpunch.aptask.com/`
7. Manage → API permissions → same as Step B items 7–9 **except omit
   `offline_access`**.

**Step D — Assign the initial break-glass admin.**

1. Entra ID → Users → New user → Create user
   - Name: `CloudPunch Break-Glass`
   - User principal name: `cloudpunch-breakglass@aptask.com`
   - Enable account: **No** (leave disabled).
2. Enterprise applications → `CloudPunch API` → Users and groups →
   Add user/group → pick the break-glass user → assign role **`Administrator`** → Assign.
3. Configure FIDO2 key registration for the break-glass user via
   Authentication methods policy.

**Step E — Assign the project owner (Abdulla) initial roles.**

Enterprise applications → `CloudPunch API` → Users and groups → Add user
→ Abdulla Sheikh → assign both `Administrator` and `Employee` → Assign.

**Step F — Share the client IDs with the codebase (later, once code exists).**

The three client IDs, the tenant ID, and the API Application ID URI are
stored as **non-secret configuration** in `docs/ops/env-vars.md` and read at
runtime from environment variables. They are safe to commit as configuration
but not as secrets.

## Follow-up

- ADR-0003 references the App Role names for the state machine's permission
  gates.
- Phase 1 will produce `packages/shared/src/roles.ts` with the exact string
  constants and a permission matrix. Do not scatter role checks throughout
  the code — always route through the shared module.

## References

- Microsoft identity platform and OAuth 2.0 auth code with PKCE —
  https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow
- App Roles vs scopes —
  https://learn.microsoft.com/entra/identity-platform/howto-add-app-roles-in-apps
- MSAL loopback IP address —
  https://learn.microsoft.com/entra/identity-platform/reply-url#localhost-exceptions
- MSAL.js SPA redirect URI guidance —
  https://learn.microsoft.com/entra/identity-platform/scenario-spa-app-registration
- Emergency access accounts —
  https://learn.microsoft.com/entra/identity/role-based-access-control/security-emergency-access
