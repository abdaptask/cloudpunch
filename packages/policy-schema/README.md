# @cloudpunch/policy-schema

JSON Schemas for CloudPunch's admin-configurable policies.

## Layout

```
idle-policy.schema.json    — idle, break, system, autostart, notifications
                             (matches docs/policy/idle-policy-defaults.md)
… (more added as new policy surfaces are introduced)
```

## Rules

- Every policy value in the database validates against its schema
  before being applied.
- **Defaults** live in the schema itself (`default` keyword) so a
  bootstrap config can be derived deterministically.
- **Bounds** (`minimum`, `maximum`, `enum`) mirror the ADR
  documentation. If the code needs a tighter bound, the schema tightens
  first.
- Overrides at team or per-employee scope are stored as partial
  documents that validate against the same schema (each nested object
  is optional).

## Consumers

- `apps/backend/src/config/policy.ts` — validates on load and on write.
- `apps/web/src/admin/policy-editor/` — drives the admin UI form
  fields (labels, ranges, help text).
