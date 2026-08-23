-- 002_core_tables.sql

CREATE TABLE risk_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key   text NOT NULL UNIQUE,
  merchant_id  uuid NOT NULL,
  source_type  source_type NOT NULL,
  customer_id  text NOT NULL,
  amount       numeric(12, 2) NOT NULL CHECK (amount > 0),
  currency     text NOT NULL DEFAULT 'INR',
  raw_reason   text,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  "group"      risk_group
);
CREATE INDEX idx_risk_event_merchant ON risk_event (merchant_id);

CREATE TABLE score (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES risk_event (id),
  p_loss          numeric(5, 4) NOT NULL CHECK (p_loss BETWEEN 0 AND 1),
  p_uplift        numeric(5, 4) NOT NULL CHECK (p_uplift BETWEEN 0 AND 1),
  expected_value  numeric(12, 2) NOT NULL,
  cost_estimate   numeric(12, 2) NOT NULL DEFAULT 0,
  scored_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_score_event ON score (event_id);

CREATE TABLE decision (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES risk_event (id),
  root_cause_summary  text NOT NULL,
  selected_action     selected_action NOT NULL,
  rationale           text NOT NULL,
  decided_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_decision_event ON decision (event_id);

CREATE TABLE policy_check (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES risk_event (id),
  check_name  policy_check_name NOT NULL,
  passed      boolean NOT NULL,
  detail      text,
  checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_policy_check_event ON policy_check (event_id);

CREATE TABLE action_execution (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES risk_event (id),
  idempotency_key  text NOT NULL UNIQUE,
  action           text NOT NULL,
  attempt_number   integer NOT NULL CHECK (attempt_number > 0),
  result           execution_result NOT NULL,
  executed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_action_execution_event ON action_execution (event_id);

CREATE TABLE outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES risk_event (id),
  payload       jsonb NOT NULL,
  published     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX idx_outbox_unpublished ON outbox (created_at) WHERE published = false;

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid,
  stage       text NOT NULL,
  detail      jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_event ON audit_log (event_id);
