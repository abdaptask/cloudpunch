-- =====================================================================
-- CloudPunch migration 0006 — where each device connects from
-- =====================================================================
--
-- Introduced: 2026-10-01
-- Implements: ADR-0029 §1, §2, §6 (connection location)
--
-- Additive only: one new table. No existing rows change, nothing is
-- dropped, and time_event stays append-only (invariant 2).
--
-- One row per device per network: a new row when the device's network
-- changes (IPv4 exact, IPv6 by /64), otherwise last_seen_at moves on
-- (at most every 15 minutes). Everything is derived on the server from
-- the request; nothing comes from the laptop.
--
-- Retention (ADR-0029 §6): a nightly job deletes rows whose
-- last_seen_at is over 30 days old. That job runs as the migrator
-- role. The app role gets no DELETE, so the API can't remove history.
-- device_connection is not time_event: the append-only rule doesn't
-- apply, and the purge is allowed.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE device_connection (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL REFERENCES employee(id),
  device_id      uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  ip             inet NOT NULL,
  city           text CHECK (length(city) <= 100),
  region         text CHECK (length(region) <= 100),
  country        text CHECK (country ~ '^[A-Z0-9]{2}$'),
  asn            integer CHECK (asn > 0),
  provider       text CHECK (length(provider) <= 200),
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX device_connection_device_idx   ON device_connection (device_id, last_seen_at DESC);
CREATE INDEX device_connection_employee_idx ON device_connection (employee_id, last_seen_at DESC);
CREATE INDEX device_connection_purge_idx    ON device_connection (last_seen_at);

COMMENT ON TABLE  device_connection IS
  'Where a device connected from, one row per network (ADR-0029). Kept 30 days; the purge runs as the migrator role.';
COMMENT ON COLUMN device_connection.ip IS
  'The address the API saw (behind Cloudflare: the visitor''s address). For IPv6, the first address seen in that /64.';
COMMENT ON COLUMN device_connection.city IS
  'Approximate, from Cloudflare''s cf-ipcity header; NULL when absent (e.g. the office network through Caddy).';
COMMENT ON COLUMN device_connection.region IS 'State, from cf-region.';
COMMENT ON COLUMN device_connection.country IS 'ISO 3166-1 alpha-2, from cf-ipcountry (Cloudflare also uses XX and T1).';
COMMENT ON COLUMN device_connection.asn IS 'Network number, from the DB-IP ASN Lite database (ADR-0029 §3); NULL until that lookup ships.';
COMMENT ON COLUMN device_connection.provider IS 'Internet provider''s name, from DB-IP ASN Lite.';

-- Grants are normally managed outside migrations; this table states
-- its own so the "no DELETE for the app role" rule is written down.
-- Skipped where the role doesn't exist (CI's throwaway database).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT, UPDATE ON device_connection TO cloudpunch_app;
  END IF;
END
$$;
