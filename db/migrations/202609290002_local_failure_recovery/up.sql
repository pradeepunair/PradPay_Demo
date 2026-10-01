BEGIN;

-- Isolated teaching fixtures. These rows cannot become orders, payments, or
-- Stripe attempts and are never accepted by the live local-demo endpoints.
CREATE TABLE IF NOT EXISTS local_demo_scenarios (
  id uuid PRIMARY KEY,
  session_hash text NOT NULL,
  scenario text NOT NULL CHECK (scenario IN ('merchant_refusal', 'unknown_outcome')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS local_demo_scenarios_expiry_idx ON local_demo_scenarios(expires_at);

COMMIT;
