-- =====================================================================
-- CloudPunch migration 0011 — the roles each person was last seen with
-- =====================================================================
--
-- Introduced: 2026-10-09
-- Implements: ADR-0037 §3 and §4 (who gets alerts when there's no
-- manager, and the Monday email): the owner chose "remember roles".
--
-- Roles live in Entra and arrive in each sign-in token (invariant 6).
-- This keeps the roles a person's latest token carried (or that
-- Settings → People last gave them), only to choose email recipients.
-- It never grants anything: every request is still checked against its
-- own token.
--
-- One row per person, updated in place (it is a current-state cache,
-- not history; role changes are audited as `roles_set` already).
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE role_seen (
  entra_object_id  uuid PRIMARY KEY,
  roles            text[] NOT NULL,
  -- 'token' (from a request) or 'people' (set in Settings → People).
  source           text NOT NULL CHECK (source IN ('token', 'people')),
  seen_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX role_seen_roles_idx ON role_seen USING gin (roles);

COMMENT ON TABLE role_seen IS
  'Roles each person was last seen with (ADR-0037). Only for choosing alert recipients; never for access.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT, UPDATE ON role_seen TO cloudpunch_app;
  END IF;
END
$$;
