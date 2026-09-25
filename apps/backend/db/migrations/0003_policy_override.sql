-- =====================================================================
-- CloudPunch migration 0003 — policy overrides
-- =====================================================================
--
-- Introduced: Phase 2b (2026-09-25)
-- Implements: ADR-0015 §1 (partial policy documents per scope),
--             docs/policy/idle-policy-defaults.md (scopes; a reason is
--             required for per-employee overrides)
--
-- Defaults are NOT stored: they live in the `default` keywords of
-- packages/policy-schema/idle-policy.schema.json. Each row is a partial
-- document validated against that schema by the API before it is
-- written (ADR-0015 §2).
--
-- scope_id has no foreign key because it points at `department` or
-- `employee` depending on scope; the API validates it.
--
-- Privileges: like the other tables, grants to the app role are managed
-- outside migrations. The app role needs SELECT, INSERT, UPDATE and
-- DELETE on policy_override (overrides are replaced and removed; the
-- history lives in audit_log).

CREATE TABLE policy_override (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope               text NOT NULL CHECK (scope IN ('global', 'department', 'employee')),
  scope_id            uuid,
  document            jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  reason              text,
  updated_by_user_id  uuid NOT NULL REFERENCES app_user(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'global') = (scope_id IS NULL)),
  CHECK (scope <> 'employee' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

COMMENT ON TABLE  policy_override IS 'Partial policy documents per scope, merged over schema defaults (ADR-0015).';
COMMENT ON COLUMN policy_override.scope_id IS 'NULL for global; department.id or employee.id otherwise.';
COMMENT ON COLUMN policy_override.document IS 'Partial idle-policy document; validated against the schema before write.';

-- One override per scope. COALESCE gives the single global row a key.
CREATE UNIQUE INDEX policy_override_scope_uniq
  ON policy_override (scope, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
