-- =====================================================================
-- CloudPunch migration 0001 — baseline identity
-- =====================================================================
--
-- Introduced: Phase 1 (2026-09-23)
-- Implements: ADR-0002 (App Roles, no local role cache),
--             ADR-0004 §5 (device enrollment fields),
--             ADR-0005 (source-of-truth column on employees + overrides),
--             ADR-0007 (extension usage limited to trusted set)
--
-- Purpose: bootstrap the identity + org tables that Phase 1 auth code
--          reads and writes. Deliberately excludes:
--            - time_session / time_event / idle_period / break_period
--              (ADR-0004; introduced in Phase 2 migration 0002)
--            - leave_record / holiday / shift_assignment
--              (introduced when greytHR inbound wiring lands)
--            - timesheet / correction_request / approval / payroll_period
--              (Phase 3 manager workflow)
--            - sync_import / sync_export / webhook_delivery
--              (Phase 4 greytHR outbound)
--            - anomaly_signal / review_case / employee_explanation
--              (Phase 5 integrity)
--
-- All timestamps use `timestamptz`. All primary keys are UUID v4 from
-- `gen_random_uuid()`. Case-insensitive email uses `citext`.
--
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ---------------------------------------------------------------------
-- Reference tables (org structure)
-- ---------------------------------------------------------------------

CREATE TABLE department (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source             text NOT NULL CHECK (source IN ('local_admin', 'greythr')),
  greythr_id         text UNIQUE,
  code               text NOT NULL UNIQUE,
  name               text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  department IS 'Org departments; source = greythr once integration is enabled.';
COMMENT ON COLUMN department.source IS 'ADR-0005: local_admin | greythr authority marker.';
COMMENT ON COLUMN department.greythr_id IS 'External ID from greytHR when source=greythr; null otherwise.';

-- ---------------------------------------------------------------------
-- Users — every Entra identity that can sign in to CloudPunch
-- ---------------------------------------------------------------------

CREATE TABLE app_user (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_object_id       uuid NOT NULL UNIQUE,
  work_email            citext NOT NULL,
  display_name          text NOT NULL,
  is_service_account    boolean NOT NULL DEFAULT false,
  break_glass           boolean NOT NULL DEFAULT false,
  last_sign_in_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  app_user IS 'Entra identities that can sign in. Not every user is an employee (see break_glass).';
COMMENT ON COLUMN app_user.entra_object_id IS 'Entra ID oid claim. Immutable per user.';
COMMENT ON COLUMN app_user.break_glass IS 'True for the cloudpunch-breakglass account per ADR-0002 §6.';
COMMENT ON COLUMN app_user.work_email IS 'Display + matching hint only; case-insensitive; may change.';

-- ---------------------------------------------------------------------
-- Employees — real people whose time is tracked
-- ---------------------------------------------------------------------

CREATE TABLE employee (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                      text NOT NULL CHECK (source IN ('local_admin', 'greythr')),
  greythr_employee_id         text UNIQUE,
  employee_number             text,
  given_name                  text NOT NULL,
  middle_name                 text,
  family_name                 text NOT NULL,
  display_name                text,
  hire_date                   date,
  termination_date            date,
  status                      text NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','inactive','terminated','on_leave')),
  department_id               uuid REFERENCES department(id),
  reporting_manager_id        uuid REFERENCES employee(id),
  authority_transitioned_at   timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (source = 'greythr' AND greythr_employee_id IS NOT NULL)
    OR
    (source = 'local_admin')
  )
);

COMMENT ON TABLE  employee IS 'Employee master. Source = local_admin at Phase 1 launch; promoted to greythr once ADR-0006 integration is active.';
COMMENT ON COLUMN employee.greythr_employee_id IS 'Immutable once set. Match key for greytHR sync (ADR-0005 §4).';
COMMENT ON COLUMN employee.reporting_manager_id IS 'Self-reference; nullable at Phase 1.';
COMMENT ON COLUMN employee.authority_transitioned_at IS 'Set when source flips local_admin -> greythr (ADR-0005 §4).';

CREATE INDEX employee_department_idx ON employee (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX employee_reporting_manager_idx ON employee (reporting_manager_id) WHERE reporting_manager_id IS NOT NULL;
CREATE INDEX employee_status_idx ON employee (status);

-- ---------------------------------------------------------------------
-- User <-> Employee link (0-or-1 employee per user, unique)
-- ---------------------------------------------------------------------

ALTER TABLE app_user
  ADD COLUMN employee_id uuid UNIQUE REFERENCES employee(id) ON DELETE SET NULL;

COMMENT ON COLUMN app_user.employee_id IS 'Nullable — break-glass and service accounts have no employee.';

-- ---------------------------------------------------------------------
-- Employee overrides (ADR-0005 §5) — time-boxed, auditable
-- ---------------------------------------------------------------------

CREATE TABLE employee_override (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         uuid NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  field_name          text NOT NULL,
  greythr_value       text,
  override_value      text,
  reason              text NOT NULL,
  actor_user_id       uuid NOT NULL REFERENCES app_user(id),
  correlation_id      uuid NOT NULL,
  effective_from      timestamptz NOT NULL DEFAULT now(),
  effective_until     timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until > effective_from),
  CHECK (field_name NOT IN ('employee_number','hire_date','termination_date'))
);

COMMENT ON TABLE  employee_override IS 'Time-boxed overrides of greythr-authoritative fields (ADR-0005 §5).';
COMMENT ON COLUMN employee_override.field_name IS 'Never allowed on employee_number, hire_date, termination_date — must be fixed in greytHR itself.';

-- Not a partial index: Postgres rejects `WHERE effective_until > now()`
-- (index predicates must be IMMUTABLE). Queries filter on
-- effective_until at run time; the trailing column serves that range.
CREATE INDEX employee_override_active_idx
  ON employee_override (employee_id, field_name, effective_until);

-- ---------------------------------------------------------------------
-- Devices — Ed25519 enrolled per user (ADR-0004 §5)
-- ---------------------------------------------------------------------

CREATE TABLE device (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  os                    text NOT NULL CHECK (os IN ('windows','macos')),
  hostname_hash         text NOT NULL,
  public_key_ed25519    bytea NOT NULL,
  app_version           text NOT NULL,
  enrolled_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz,
  revoked_at            timestamptz,
  revoked_reason        text,
  revoked_by_user_id    uuid REFERENCES app_user(id),
  CHECK (octet_length(public_key_ed25519) = 32),
  CHECK ((revoked_at IS NULL AND revoked_reason IS NULL AND revoked_by_user_id IS NULL)
         OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL AND revoked_by_user_id IS NOT NULL))
);

COMMENT ON TABLE  device IS 'Enrolled Windows/macOS agents. Ed25519 public key registered at first launch.';
COMMENT ON COLUMN device.hostname_hash IS 'SHA-256 of the hostname; plaintext never stored.';
COMMENT ON COLUMN device.public_key_ed25519 IS 'Raw 32-byte Ed25519 public key (ADR-0004 §5).';
COMMENT ON COLUMN device.revoked_at IS 'When set, events dated after this on this device are rejected.';

CREATE INDEX device_user_active_idx ON device (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- Admin review cases — created when reconciliation cannot auto-resolve
-- ---------------------------------------------------------------------

CREATE TABLE admin_review_case (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN (
    'EMPLOYEE_MATCH_AMBIGUOUS',
    'EMPLOYEE_MAPPING_FAILED',
    'SIGN_IN_NO_EMPLOYEE',
    'TERMINATION_MID_SHIFT',
    'CLOCK_MANIPULATION_SUSPECTED',
    'MULTI_DEVICE_CONCURRENT_ACTIVITY',
    'EXPORT_FAILED_CONFLICT'
  )),
  subject_user_id       uuid REFERENCES app_user(id),
  subject_employee_id   uuid REFERENCES employee(id),
  details               jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','in_review','resolved','dismissed')),
  assigned_to_user_id   uuid REFERENCES app_user(id),
  resolution_notes      text,
  correlation_id        uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz
);

COMMENT ON TABLE admin_review_case IS 'Cases surfaced to admins when the system cannot auto-resolve (ADR-0005 §4, §7, §8).';

CREATE INDEX admin_review_case_open_idx ON admin_review_case (status, created_at DESC)
  WHERE status IN ('open','in_review');

-- ---------------------------------------------------------------------
-- Audit log — append-only, hash-chainable in a later phase
-- ---------------------------------------------------------------------

CREATE TABLE audit_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type          text NOT NULL CHECK (actor_type IN ('user','service','system')),
  actor_user_id       uuid REFERENCES app_user(id),
  entity_type         text NOT NULL,
  entity_id           uuid,
  action              text NOT NULL,
  previous_value      jsonb,
  new_value           jsonb,
  reason              text,
  correlation_id      uuid NOT NULL,
  occurred_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  audit_log IS 'Append-only mutation log. Any UPDATE/DELETE on this table is blocked by a Phase 2 trigger.';
COMMENT ON COLUMN audit_log.actor_user_id IS 'Nullable for system actions.';
COMMENT ON COLUMN audit_log.entity_id IS 'Nullable for actions without a specific entity (e.g., config change).';

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX audit_log_correlation_idx ON audit_log (correlation_id);

-- ---------------------------------------------------------------------
-- Roles — no local table (per ADR-0002 §6, App Role state is in Entra)
-- ---------------------------------------------------------------------
-- Role assignment events are recorded in audit_log with
-- action='role_assign' / 'role_revoke' and previous_value / new_value
-- capturing the role name. This preserves the who/when/why without
-- introducing a drift-prone cache.

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER department_set_updated_at
  BEFORE UPDATE ON department
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER employee_set_updated_at
  BEFORE UPDATE ON employee
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER app_user_set_updated_at
  BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- End of migration 0001
-- =====================================================================

COMMIT;
