BEGIN;

CREATE TABLE IF NOT EXISTS visitor_sessions (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  admission_limit integer NOT NULL DEFAULT 0 CHECK (admission_limit >= 0),
  admitted_count integer NOT NULL DEFAULT 0 CHECK (admitted_count >= 0 AND admitted_count <= admission_limit)
);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  session_id text NOT NULL REFERENCES visitor_sessions(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('guided_replay','live_sandbox')),
  scenario text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','awaiting_permission','awaiting_authentication','awaiting_payment','succeeded','blocked','failed','canceled','expired')),
  reference_time timestamptz NOT NULL,
  schema_version text NOT NULL,
  next_event_sequence bigint NOT NULL DEFAULT 0 CHECK (next_event_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, id)
);
CREATE INDEX IF NOT EXISTS runs_session_created_idx ON runs(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS checkouts (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  session_id text NOT NULL,
  run_id text NOT NULL,
  acp_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','quoted','ready','completing','completed','canceled','expired')),
  cart_version integer NOT NULL DEFAULT 1 CHECK (cart_version > 0),
  cart_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, id),
  UNIQUE (run_id, id),
  UNIQUE (session_id, run_id, id),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS checkouts_owner_idx ON checkouts(session_id, run_id);
CREATE INDEX IF NOT EXISTS checkouts_run_state_idx ON checkouts(run_id, state);

CREATE TABLE IF NOT EXISTS quotes (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  checkout_id text NOT NULL REFERENCES checkouts(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  shipping_minor bigint NOT NULL CHECK (shipping_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor = subtotal_minor + shipping_minor + tax_minor),
  expires_at timestamptz NOT NULL,
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(assumptions) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkout_id, version)
);

CREATE TABLE IF NOT EXISTS mandates (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  session_id text NOT NULL,
  run_id text NOT NULL,
  checkout_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('draft','active','reserved','consumed','expired','revoked')),
  approved_text text NOT NULL,
  constraints jsonb NOT NULL CHECK (jsonb_typeof(constraints) = 'object'),
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  maximum_amount_minor bigint NOT NULL CHECK (maximum_amount_minor >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, checkout_id) REFERENCES checkouts(run_id, id) ON DELETE RESTRICT,
  UNIQUE (session_id, id),
  UNIQUE (session_id, run_id, id),
  UNIQUE (session_id, run_id, checkout_id, id)
);
CREATE INDEX IF NOT EXISTS mandates_owner_idx ON mandates(session_id, run_id);

CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  session_id text NOT NULL,
  run_id text NOT NULL,
  checkout_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('pending_payment','confirmed','payment_failed','canceled')),
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  evidence_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, run_id, checkout_id) REFERENCES checkouts(session_id, run_id, id) ON DELETE RESTRICT,
  UNIQUE (session_id, id),
  UNIQUE (session_id, run_id, id),
  UNIQUE (session_id, run_id, checkout_id, id)
);

CREATE TABLE IF NOT EXISTS payments (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  session_id text NOT NULL,
  run_id text NOT NULL,
  checkout_id text NOT NULL,
  order_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  provider text,
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, run_id, checkout_id) REFERENCES checkouts(session_id, run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, run_id, checkout_id, order_id) REFERENCES orders(session_id, run_id, checkout_id, id) ON DELETE RESTRICT,
  CHECK ((provider IS NULL) = (provider_reference IS NULL)),
  UNIQUE (session_id, id),
  UNIQUE (session_id, run_id, id),
  UNIQUE (session_id, run_id, checkout_id, id)
);
CREATE INDEX IF NOT EXISTS payments_checkout_idx ON payments(checkout_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_reference_idx
  ON payments(provider, provider_reference) WHERE provider IS NOT NULL AND provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_attempts (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  session_id text NOT NULL,
  run_id text NOT NULL,
  checkout_id text NOT NULL,
  payment_id text NOT NULL,
  mandate_id text NOT NULL,
  operation_key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared','submitted','requires_action','processing','succeeded','failed','canceled','unknown')),
  provider_state text,
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, run_id, checkout_id) REFERENCES checkouts(session_id, run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, run_id, checkout_id, payment_id) REFERENCES payments(session_id, run_id, checkout_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, run_id, checkout_id, mandate_id) REFERENCES mandates(session_id, run_id, checkout_id, id) ON DELETE RESTRICT,
  UNIQUE (session_id, operation_key),
  UNIQUE (session_id, operation_key, request_hash),
  UNIQUE (session_id, run_id, id),
  UNIQUE (mandate_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_active_checkout_idx
  ON payment_attempts(checkout_id)
  WHERE state IN ('prepared','submitted','requires_action','processing','unknown');
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_success_mandate_idx
  ON payment_attempts(mandate_id) WHERE state = 'succeeded';
CREATE INDEX IF NOT EXISTS payment_attempts_reconciliation_idx
  ON payment_attempts(state, updated_at) WHERE state = 'unknown';

CREATE TABLE IF NOT EXISTS mandate_usages (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  mandate_id text NOT NULL,
  attempt_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('reserved','succeeded','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mandate_id, attempt_id) REFERENCES payment_attempts(mandate_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS mandate_usages_one_success_idx
  ON mandate_usages(mandate_id) WHERE status = 'succeeded';

CREATE TABLE IF NOT EXISTS webhook_receipts (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  livemode boolean NOT NULL DEFAULT false CHECK (livemode = false),
  state text NOT NULL CHECK (state IN ('received','verified','applied','duplicate','rejected','retry_pending')),
  safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_payload) = 'object'),
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS webhook_receipts_pending_idx ON webhook_receipts(state, received_at) WHERE state IN ('verified','retry_pending');

CREATE TABLE IF NOT EXISTS domain_events (
  event_id text PRIMARY KEY CHECK (length(btrim(event_id)) > 0),
  session_id text NOT NULL,
  run_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  type text NOT NULL CHECK (length(btrim(type)) > 0),
  schema_version text NOT NULL CHECK (length(btrim(schema_version)) > 0),
  safe_payload jsonb NOT NULL CHECK (jsonb_typeof(safe_payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT,
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS domain_events_owner_sequence_idx ON domain_events(session_id, run_id, sequence);
CREATE INDEX IF NOT EXISTS domain_events_type_idx ON domain_events(type, occurred_at);

CREATE TABLE IF NOT EXISTS outbox_jobs (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  session_id text NOT NULL,
  run_id text NOT NULL,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  safe_payload jsonb NOT NULL CHECK (jsonb_typeof(safe_payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','succeeded','failed','dead')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT,
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS outbox_jobs_lease_idx ON outbox_jobs(state, available_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS outbox_jobs_run_idx ON outbox_jobs(run_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  session_id text NOT NULL REFERENCES visitor_sessions(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (length(btrim(scope)) > 0),
  key text NOT NULL CHECK (length(btrim(key)) > 0),
  request_hash text NOT NULL CHECK (length(btrim(request_hash)) > 0),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, scope, key),
  UNIQUE (session_id, scope, key, request_hash)
);

CREATE OR REPLACE FUNCTION reject_idempotency_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.session_id, NEW.scope, NEW.key, NEW.request_hash)
     IS DISTINCT FROM (OLD.session_id, OLD.scope, OLD.key, OLD.request_hash) THEN
    RAISE EXCEPTION 'idempotency identity and request hash are immutable' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS idempotency_keys_immutable_identity ON idempotency_keys;
CREATE TRIGGER idempotency_keys_immutable_identity
BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION reject_idempotency_identity_change();

CREATE TABLE IF NOT EXISTS reconciliation_jobs (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  session_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('pending','leased','resolved','failed','dead')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, run_id, attempt_id) REFERENCES payment_attempts(session_id, run_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS reconciliation_jobs_due_idx ON reconciliation_jobs(state, available_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS admission_usage (
  session_id text NOT NULL REFERENCES visitor_sessions(id) ON DELETE RESTRICT,
  usage_date date NOT NULL,
  admitted_runs integer NOT NULL DEFAULT 0 CHECK (admitted_runs >= 0),
  PRIMARY KEY (session_id, usage_date)
);

CREATE OR REPLACE FUNCTION append_domain_event(
  p_event_id text, p_run_id text, p_session_id text, p_type text,
  p_schema_version text, p_safe_payload jsonb
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE allocated_sequence bigint;
BEGIN
  IF jsonb_typeof(p_safe_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'safe payload must be an object' USING ERRCODE = '22023';
  END IF;
  UPDATE runs
     SET next_event_sequence = next_event_sequence + 1, updated_at = now()
   WHERE id = p_run_id AND session_id = p_session_id
   RETURNING next_event_sequence INTO allocated_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run not found in session scope' USING ERRCODE = '42501';
  END IF;
  INSERT INTO domain_events(event_id, session_id, run_id, sequence, type, schema_version, safe_payload)
  VALUES (p_event_id, p_session_id, p_run_id, allocated_sequence, p_type, p_schema_version, p_safe_payload);
  RETURN allocated_sequence;
END;
$$;

CREATE OR REPLACE FUNCTION claim_idempotency(
  p_session_id text, p_scope text, p_key text, p_request_hash text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE existing_hash text;
BEGIN
  INSERT INTO idempotency_keys(session_id, scope, key, request_hash)
  VALUES (p_session_id, p_scope, p_key, p_request_hash)
  ON CONFLICT (session_id, scope, key) DO NOTHING;
  IF FOUND THEN RETURN 'created'; END IF;
  SELECT request_hash INTO existing_hash FROM idempotency_keys
   WHERE session_id = p_session_id AND scope = p_scope AND key = p_key FOR UPDATE;
  IF existing_hash = p_request_hash THEN RETURN 'replay'; END IF;
  RETURN 'conflict';
END;
$$;

CREATE OR REPLACE FUNCTION record_webhook_receipt(
  p_id text, p_provider text, p_provider_event_id text, p_event_type text,
  p_safe_payload jsonb, p_occurred_at timestamptz DEFAULT NULL
) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(p_safe_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'safe payload must be an object' USING ERRCODE = '22023';
  END IF;
  INSERT INTO webhook_receipts(id, provider, provider_event_id, event_type, state, safe_payload, occurred_at)
  VALUES (p_id, p_provider, p_provider_event_id, p_event_type, 'verified', p_safe_payload, p_occurred_at)
  ON CONFLICT (provider, provider_event_id) DO NOTHING;
  IF FOUND THEN RETURN 'created'; END IF;
  RETURN 'duplicate';
END;
$$;

COMMIT;
