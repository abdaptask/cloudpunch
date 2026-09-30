-- =====================================================================
-- CloudPunch migration 0005 — admin sign-out of a machine
-- =====================================================================
--
-- Introduced: 2026-09-30
-- Implements: ADR-0028 §4 (one machine at a time: an Administrator can
--             sign a person out of the machine they're clocked in on)
--
-- Additive only: two nullable columns on device. No rows change,
-- nothing is dropped, and time_event stays append-only (invariant 2).
--
--   signout_requested_at  set when an Administrator signs the machine
--                         out; that device's event batches then get
--                         409 device_signed_out. Cleared when the
--                         device enrols again after a new sign-in.
--   signout_requested_by  the Administrator's app_user id.
--
-- Privileges: like the other tables, grants to the app role are managed
-- outside migrations. The app role already has UPDATE on device (it
-- writes last_seen_at, app_version and revocation); a table-level
-- UPDATE grant covers new columns, so nothing else is needed. If the
-- grant is ever narrowed to column level, it must include both columns.

ALTER TABLE device
  ADD COLUMN signout_requested_at timestamptz,
  ADD COLUMN signout_requested_by uuid REFERENCES app_user(id);

COMMENT ON COLUMN device.signout_requested_at IS
  'When an Administrator signed this machine out (ADR-0028 §4). While set, its event batches get 409 device_signed_out; cleared when it enrols again.';
COMMENT ON COLUMN device.signout_requested_by IS
  'The Administrator (app_user.id) who signed this machine out; set with signout_requested_at.';
