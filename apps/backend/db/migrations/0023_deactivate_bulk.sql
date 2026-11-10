-- =====================================================================
-- CloudPunch migration 0023 — "Deactivate selected" bulk requests
-- =====================================================================
--
-- Introduced: 2026-11-10
-- Implements: ADR-0052 §5
--
-- Bulk deactivation keeps its answer in admin_bulk_request by its
-- idempotency key like the other bulk changes (invariant 4). This only
-- widens the kinds allowed. Deactivation itself needs no new column:
-- employee.status already allows 'inactive', and its one audit row goes
-- in audit_log.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

ALTER TABLE admin_bulk_request DROP CONSTRAINT admin_bulk_request_kind_check;
ALTER TABLE admin_bulk_request ADD CONSTRAINT admin_bulk_request_kind_check
  CHECK (kind IN ('manager', 'roles', 'welcome', 'shift', 'office', 'deactivate'));
