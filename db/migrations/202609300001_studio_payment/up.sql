BEGIN;

CREATE TABLE IF NOT EXISTS studio_payment_operations (
  operation_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES visitor_sessions(id) ON DELETE RESTRICT,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  operation_key text NOT NULL,
  request_hash char(64) NOT NULL,
  attempt_id text NOT NULL UNIQUE,
  scenario text NOT NULL CHECK (scenario IN ('succeeded','declined','duplicate_callback','callback_before_response','timeout_after_effect','timeout_before_effect')),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','dispatching','unknown','succeeded','declined','expired')),
  dispatch_count integer NOT NULL DEFAULT 0 CHECK (dispatch_count BETWEEN 0 AND 1),
  quote_hash text NOT NULL,
  approval_id text NOT NULL,
  token_scope jsonb NOT NULL CHECK (jsonb_typeof(token_scope) = 'object'),
  authority_state text NOT NULL DEFAULT 'reserved' CHECK (authority_state IN ('reserved','consumed','expired')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  provider_state jsonb,
  order_id text NOT NULL UNIQUE,
  order_status text NOT NULL DEFAULT 'pending_payment' CHECK (order_status IN ('pending_payment','confirmed','payment_failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, operation_key),
  UNIQUE (session_id, run_id)
);
CREATE INDEX IF NOT EXISTS studio_payment_operations_session_idx ON studio_payment_operations(session_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS studio_payment_one_unresolved_session_idx
  ON studio_payment_operations(session_id) WHERE status IN ('reserved','dispatching','unknown');

CREATE TABLE IF NOT EXISTS studio_payment_receipts (
  provider_event_id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES studio_payment_operations(operation_id) ON DELETE RESTRICT,
  attempt_id text NOT NULL,
  safe_event jsonb NOT NULL CHECK (jsonb_typeof(safe_event) = 'object'),
  applied boolean NOT NULL DEFAULT false,
  disposition text NOT NULL DEFAULT 'pending',
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS studio_payment_receipts_operation_idx ON studio_payment_receipts(operation_id, received_at);

COMMIT;
