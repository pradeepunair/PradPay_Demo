BEGIN;

-- The local demonstration uses the owned-run, checkout, mandate, order, payment,
-- attempt, event, and webhook tables from M2. This table holds only its UI view.
CREATE TABLE IF NOT EXISTS local_demo_journeys (
  run_id text PRIMARY KEY,
  session_id text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT
);

-- Stripe helper progress is stored without the SPT, key, raw callback, or card data.
-- One run can reserve only one attempt, including across process restarts.
CREATE TABLE IF NOT EXISTS local_demo_attempt_journals (
  run_id text PRIMARY KEY REFERENCES local_demo_journeys(run_id) ON DELETE RESTRICT,
  attempt_id text NOT NULL UNIQUE REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  journal jsonb NOT NULL CHECK (jsonb_typeof(journal) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
