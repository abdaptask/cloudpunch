-- =====================================================================
-- CloudPunch migration 0013 — bulk admin changes, once per key
-- =====================================================================
--
-- Introduced: 2026-10-12
-- Implements: ADR-0038 §5 (bulk changes in the admin console)
--
-- One row per bulk request (set manager, add/remove a role, welcome
-- emails), keyed by the caller and the request's idempotency key
-- (invariant 4). A retry with the same key gets the stored answer and
-- changes nothing; the same key with a different request is refused.
-- Each person changed still gets their own audit_log row, with the
-- shared reason and the batch's correlation id.
--
-- Append-only, like the other history tables.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE admin_bulk_request (
  actor_user_id    uuid NOT NULL REFERENCES app_user(id),
  idempotency_key  uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('manager', 'roles', 'welcome')),
  -- SHA-256 of the request body without the key, to spot a reused key.
  request_hash     text NOT NULL,
  -- The answer that was sent, returned as-is on a retry.
  result           jsonb NOT NULL,
  correlation_id   uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, idempotency_key)
);

COMMENT ON TABLE admin_bulk_request IS
  'Bulk admin changes, one row per idempotency key (ADR-0038 §5). Append-only.';

CREATE TRIGGER admin_bulk_request_no_update
  BEFORE UPDATE ON admin_bulk_request
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER admin_bulk_request_no_delete
  BEFORE DELETE ON admin_bulk_request
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT ON admin_bulk_request TO cloudpunch_app;
  END IF;
END
$$;
