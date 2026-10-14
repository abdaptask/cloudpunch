-- =====================================================================
-- CloudPunch migration 0021 — actionable insights: findings as cases
-- =====================================================================
--
-- Introduced: 2026-10-14
-- Implements: ADR-0047 §2
--
-- `insight` holds each finding's current state (one live finding per
-- person and kind, updated in place as evidence grows or its state
-- changes). `insight_event` is its history: opened, updated, nudged,
-- explained, dismissed, resolved, reopened. Append-only, like every
-- CloudPunch history.
--
-- No BEGIN/COMMIT: the runner applies each file in its own transaction.

CREATE TABLE insight (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employee(id),
  kind          text NOT NULL CHECK (kind IN ('late_starts','missed_starts','short_days',
                  'long_idle','breaks_over','forgets_clock_out','long_days')),
  severity      text NOT NULL CHECK (severity IN ('info','warning','serious')),
  status        text NOT NULL CHECK (status IN ('open','nudged','resolved','dismissed')),
  -- The days behind it and the 14-day strip (ADR-0047 §2).
  evidence      jsonb NOT NULL,
  -- After a nudge: when to check again.
  follow_up_on  date,
  -- Back to open because the follow-up found no change.
  no_change     boolean NOT NULL DEFAULT false,
  opened_at     timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);

-- One live (open or nudged) finding per person and kind.
CREATE UNIQUE INDEX insight_one_live ON insight (employee_id, kind)
  WHERE status IN ('open', 'nudged');
CREATE INDEX insight_status_idx ON insight (status, updated_at DESC);

COMMENT ON TABLE insight IS
  'A finding about one person, tracked as a case (ADR-0047). Current state; its history is insight_event.';

CREATE TABLE insight_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_id     uuid NOT NULL REFERENCES insight(id),
  action         text NOT NULL CHECK (action IN ('opened','updated','nudged','explained',
                   'dismissed','resolved','reopened')),
  -- Who; NULL for CloudPunch itself (the nightly check).
  actor_user_id  uuid REFERENCES app_user(id),
  note           text CHECK (note IS NULL OR length(note) <= 4000),
  detail         jsonb,
  at             timestamptz NOT NULL DEFAULT now(),
  -- Insertion order, for lines recorded at the same instant.
  seq            bigint GENERATED ALWAYS AS IDENTITY
);

CREATE INDEX insight_event_insight_idx ON insight_event (insight_id, at, seq);

COMMENT ON TABLE insight_event IS
  'The history of a finding (ADR-0047 §2). Append-only.';

CREATE TRIGGER insight_event_no_update
  BEFORE UPDATE ON insight_event
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();
CREATE TRIGGER insight_event_no_delete
  BEFORE DELETE ON insight_event
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation_on_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudpunch_app') THEN
    GRANT SELECT, INSERT, UPDATE ON insight TO cloudpunch_app;
    GRANT SELECT, INSERT ON insight_event TO cloudpunch_app;
  END IF;
END
$$;
