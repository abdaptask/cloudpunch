# @cloudpunch/shared

Types and constants that must stay identical across the backend, the web
dashboard, and the desktop UI.

The contents of this package are load-bearing:

- **`roles.ts`** — the exact `AppRole` string constants that appear in
  Microsoft Entra ID access tokens' `roles` claim (per ADR-0002 §2).
  Renaming any value here is a breaking authentication change.
- **`permissions.ts`** — the `Capability` enum and the
  `ROLE_CAPABILITIES` matrix. Every protected backend route reads this
  to authorize a request.

Everything exported is `Readonly` at runtime and `readonly` at the type
level. Callers must not mutate.
