-- =====================================================================
-- CloudPunch migration 0014 — named shifts
-- =====================================================================
--
-- Introduced: 2026-10-12
-- Implements: ADR-0038 §6 (named shifts) and §5 (bulk shift)
--
-- An Administrator sets up a named shift once ("India day · Mon–Fri
-- 09:00–18:00 IST") and gives it to people by name. Editing it changes
-- it for everyone on it, from a chosen date.
--
-- shift_template: one row per named shift.
-- shift_template_version: its name and pattern from a date; the latest
--   version on or before a date applies. Retiring is a new version
--   with `retired`, keeping the pattern: people on it keep it until
--   moved.
-- shift_assignment.template_id: a row with one follows the named shift
--   from its effective_from (its own days/times are a snapshot of the
--   version then, kept for reading); a row without one is today's
--   custom pattern. Existing rows are untouched and stay custom.
--
-- All append-only. admin_bulk_request (0013) gains the 'shift' kind.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE shift_template (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user_id  uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shift_template_version (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         uuid NOT NULL REFERENCES shift_template(id),
  name                varchar(100) NOT NULL CHECK (length(trim(name)) > 0),
  -- ISO weekdays, 1 = Monday … 7 = Sunday; a named shift has days.
  days                smallint[] NOT NULL
                        CHECK (cardinality(days) > 0 AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  start_time          time NOT NULL,
  end_time            time NOT NULL CHECK (end_time <> start_time),
  tz_iana             varchar(64) NOT NULL,
  retired             boolean NOT NULL DEFAULT false,
  effective_from      date NOT NULL,
  reason              text CHECK (reason IS NULL OR length(reason) <= 500),
  created_by_user_id  uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shift_template_version_idx
  ON shift_template_version (template_id, effective_from DESC, created_at DESC);

COMMENT ON TABLE shift_template IS
  'A named shift (ADR-0038 §6). Append-only; its name and pattern are in shift_template_version.';
COMMENT ON TABLE shift_template_version IS
  'A named shift''s name and pattern from effective_from (ADR-0038 §6). Append-only; the latest on or before a date applies.';

ALTER TABLE shift_assignment ADD COLUMN template_id uuid REFERENCES shift_template(id);
COMMENT ON COLUMN shift_assignment.template_id IS
  'Set: follows this named shift from effective_from (days/times are a snapshot). Null: a custom pattern.';

ALTER TABLE admin_bulk_request DROP CONSTRAINT admin_bulk_request_kind_check;
ALTER TABLE admin_bulk_request ADD CONSTRAINT admin_bulk_request_kind_check
  CHECK (kind IN ('manager', 'roles', 'welcome', 'shift'));

CREATE TRIGGER shift_template_no_update
  BEFORE UPDATE ON shift_template
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER shift_template_no_delete
  BEFORE DELETE ON shift_template
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER shift_template_version_no_update
  BEFORE UPDATE ON shift_template_version
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER shift_template_version_no_delete
  BEFORE DELETE ON shift_template_version
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT ON shift_template, shift_template_version TO cloudpunch_app;
  END IF;
END
$$;
