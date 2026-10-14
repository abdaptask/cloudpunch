-- =====================================================================
-- CloudPunch migration 0019 — data retention: the one purge path
-- =====================================================================
--
-- Introduced: 2026-10-14
-- Implements: ADR-0044 §2
--
-- The append-only triggers keep refusing every UPDATE, and every DELETE
-- unless the transaction holds a purge lock that only
-- cloudpunch_retention_purge() can write. That function (SECURITY
-- DEFINER, owned by the migrating role) is the only way rows leave an
-- append-only table. It refuses periods below each kind's floor, and a
-- real run writes one audit_log row. The app role may EXECUTE it and
-- still has no DELETE on those tables.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

-- The lock: this transaction's id and a random token, written and
-- removed by the purge function alone. No privileges for anyone else.
CREATE TABLE retention_purge_lock (
  xact        xid8 PRIMARY KEY,
  token       text NOT NULL,
  kind        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE retention_purge_lock IS
  'Held by cloudpunch_retention_purge() for its own transaction only (ADR-0044 §2). Empty outside a purge.';

REVOKE ALL ON retention_purge_lock FROM PUBLIC;

-- Whether this transaction is inside a purge: a lock row for it, whose
-- token matches the transaction-local setting the purge set. SECURITY
-- DEFINER so the trigger can read the lock table whoever is deleting.
-- Every append-only trigger is FOR EACH STATEMENT, so letting the
-- statement through can't skip rows silently.
CREATE OR REPLACE FUNCTION retention_purge_allowed() RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM retention_purge_lock
    WHERE xact = pg_current_xact_id_if_assigned()
      AND token = current_setting('cloudpunch.retention_purge', true)
  );
$$;

COMMENT ON FUNCTION retention_purge_allowed IS
  'True only inside cloudpunch_retention_purge() (ADR-0044 §2).';

-- Same guard as migration 0002, with the purge as the only exception,
-- and only for DELETE.
CREATE OR REPLACE FUNCTION deny_mutation_on_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND retention_purge_allowed() THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION
    'Table % is append-only; UPDATE and DELETE are not permitted', TG_TABLE_NAME
    USING
      ERRCODE = 'insufficient_privilege',
      HINT    = 'Old rows leave only through cloudpunch_retention_purge() (ADR-0044).';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION deny_mutation_on_append_only IS
  'Raises 42501 on any UPDATE/DELETE against an append-only table, except a DELETE inside cloudpunch_retention_purge() (ADR-0044).';

-- retention-purge:begin (ADR-0044 §2: the only deletes from append-only
-- tables in this repository; the CI invariant scan allows this block
-- and nothing else.)
CREATE OR REPLACE FUNCTION cloudpunch_retention_purge(
  p_kind    text,
  p_days    integer,
  p_dry_run boolean DEFAULT true
) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_floor  integer;
  v_cutoff timestamptz;
  v_count  bigint := 0;
  v_n      bigint;
BEGIN
  -- Floors (ADR-0044 §1): no setting or caller can go below these.
  v_floor := CASE p_kind
    WHEN 'time_records'  THEN 1096
    WHEN 'audit_log'     THEN 1096
    WHEN 'idle_notes'    THEN 90
    WHEN 'notifications' THEN 120
    WHEN 'operational'   THEN 30
  END;
  IF v_floor IS NULL THEN
    RAISE EXCEPTION 'unknown retention kind %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_days IS NULL OR p_days < v_floor THEN
    RAISE EXCEPTION '% must be kept at least % days', p_kind, v_floor USING ERRCODE = '22023';
  END IF;
  v_cutoff := now() - make_interval(days => p_days);

  IF p_dry_run THEN
    IF p_kind = 'time_records' THEN
      SELECT count(*) INTO v_n FROM time_event e JOIN time_session s ON s.id = e.session_id
        WHERE s.closed_at < v_cutoff
          AND (s.legal_hold_until IS NULL OR s.legal_hold_until < current_date);
      v_count := v_n;
      SELECT count(*) INTO v_n FROM time_session s
        WHERE s.closed_at < v_cutoff
          AND (s.legal_hold_until IS NULL OR s.legal_hold_until < current_date);
      v_count := v_count + v_n;
      SELECT count(*) INTO v_n FROM time_correction_decision d
        JOIN time_correction c ON c.id = d.correction_id WHERE c.to_at < v_cutoff;
      v_count := v_count + v_n;
      SELECT count(*) INTO v_n FROM time_correction c WHERE c.to_at < v_cutoff;
      v_count := v_count + v_n;
    ELSIF p_kind = 'idle_notes' THEN
      SELECT count(*) INTO v_count FROM time_event e
        WHERE e.event_type = 'USER_IDLE_EXPLAINED' AND e.server_ts < v_cutoff
          AND coalesce(e.payload->>'explanation', '') <> 'break';
    ELSIF p_kind = 'audit_log' THEN
      SELECT count(*) INTO v_count FROM audit_log a WHERE a.occurred_at < v_cutoff;
    ELSIF p_kind = 'notifications' THEN
      SELECT (SELECT count(*) FROM shift_alert WHERE sent_at < v_cutoff)
           + (SELECT count(*) FROM weekly_report_sent WHERE sent_at < v_cutoff)
           + (SELECT count(*) FROM report_sent WHERE sent_at < v_cutoff)
           + (SELECT count(*) FROM location_alert WHERE sent_at < v_cutoff)
        INTO v_count;
    ELSE
      SELECT (SELECT count(*) FROM upload_refusal WHERE last_at < v_cutoff)
           + (SELECT count(*) FROM admin_bulk_request WHERE created_at < v_cutoff)
        INTO v_count;
    END IF;
    RETURN v_count;
  END IF;

  -- A real run: take the lock for this transaction only.
  INSERT INTO retention_purge_lock (xact, token, kind)
    VALUES (pg_current_xact_id(), gen_random_uuid()::text, p_kind);
  PERFORM set_config('cloudpunch.retention_purge',
    (SELECT token FROM retention_purge_lock WHERE xact = pg_current_xact_id()), true);

  IF p_kind = 'time_records' THEN
    DELETE FROM time_event e USING time_session s
      WHERE s.id = e.session_id AND s.closed_at < v_cutoff
        AND (s.legal_hold_until IS NULL OR s.legal_hold_until < current_date);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_n;
    DELETE FROM time_session s
      WHERE s.closed_at < v_cutoff
        AND (s.legal_hold_until IS NULL OR s.legal_hold_until < current_date)
        AND NOT EXISTS (SELECT 1 FROM time_event e WHERE e.session_id = s.id);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + v_n;
    DELETE FROM time_correction_decision d USING time_correction c
      WHERE c.id = d.correction_id AND c.to_at < v_cutoff;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + v_n;
    DELETE FROM time_correction c WHERE c.to_at < v_cutoff;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + v_n;
  ELSIF p_kind = 'idle_notes' THEN
    DELETE FROM time_event e
      WHERE e.event_type = 'USER_IDLE_EXPLAINED' AND e.server_ts < v_cutoff
        AND coalesce(e.payload->>'explanation', '') <> 'break';
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_kind = 'audit_log' THEN
    DELETE FROM audit_log a WHERE a.occurred_at < v_cutoff;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_kind = 'notifications' THEN
    DELETE FROM shift_alert WHERE sent_at < v_cutoff;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_n;
    DELETE FROM weekly_report_sent WHERE sent_at < v_cutoff;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + v_n;
    DELETE FROM report_sent WHERE sent_at < v_cutoff;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + v_n;
    DELETE FROM location_alert WHERE sent_at < v_cutoff;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + v_n;
  ELSE
    DELETE FROM upload_refusal WHERE last_at < v_cutoff;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_n;
    DELETE FROM admin_bulk_request WHERE created_at < v_cutoff;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_count := v_count + v_n;
  END IF;

  -- Give the lock back before anything else runs in this transaction.
  DELETE FROM retention_purge_lock WHERE xact = pg_current_xact_id();
  PERFORM set_config('cloudpunch.retention_purge', '', true);

  INSERT INTO audit_log (actor_type, actor_user_id, entity_type, entity_id, action,
                         previous_value, new_value, reason, correlation_id, occurred_at)
  VALUES ('system', NULL, 'retention', NULL, 'retention_purged', NULL,
          jsonb_build_object('kind', p_kind, 'days', p_days, 'cutoff', v_cutoff,
                             'rows', v_count),
          NULL, gen_random_uuid(), now());
  RETURN v_count;
END;
$$;
-- retention-purge:end

COMMENT ON FUNCTION cloudpunch_retention_purge IS
  'ADR-0044: the only way rows leave an append-only table. Floors per kind; dry run counts only; a real run writes one audit_log row.';

REVOKE ALL ON FUNCTION cloudpunch_retention_purge(text, integer, boolean) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT EXECUTE ON FUNCTION cloudpunch_retention_purge(text, integer, boolean) TO cloudpunch_app;
  END IF;
END
$$;
