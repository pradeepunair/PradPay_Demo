BEGIN;

CREATE TABLE IF NOT EXISTS safety_controls (
  environment text PRIMARY KEY CHECK (environment ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  payment_admission_enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Za-z0-9][A-Za-z0-9_]{0,63}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS synthetic_budget_policies (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  environment text NOT NULL CHECK (environment ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  scope_type text NOT NULL CHECK (scope_type IN ('environment','session','run')),
  session_id text REFERENCES visitor_sessions(id) ON DELETE RESTRICT,
  run_id text,
  maximum_amount_minor bigint NOT NULL CHECK (maximum_amount_minor >= 0),
  attempt_ceiling integer NOT NULL CHECK (attempt_ceiling >= 0),
  window_starts_at timestamptz NOT NULL,
  window_ends_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_ends_at > window_starts_at),
  CHECK (
    (scope_type = 'environment' AND session_id IS NULL AND run_id IS NULL) OR
    (scope_type = 'session' AND session_id IS NOT NULL AND run_id IS NULL) OR
    (scope_type = 'run' AND session_id IS NOT NULL AND run_id IS NOT NULL)
  ),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS synthetic_budget_policies_scope_idx
  ON synthetic_budget_policies(environment, scope_type, session_id, run_id, window_starts_at, window_ends_at);

CREATE TABLE IF NOT EXISTS synthetic_budget_counters (
  policy_id text PRIMARY KEY REFERENCES synthetic_budget_policies(id) ON DELETE RESTRICT,
  consumed_amount_minor bigint NOT NULL DEFAULT 0 CHECK (consumed_amount_minor >= 0),
  consumed_attempt_count integer NOT NULL DEFAULT 0 CHECK (consumed_attempt_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS synthetic_admission_decisions (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  environment text NOT NULL,
  requested_policy_id text NOT NULL,
  policy_id text REFERENCES synthetic_budget_policies(id) ON DELETE RESTRICT,
  session_id text NOT NULL,
  run_id text NOT NULL,
  operation_key text NOT NULL CHECK (length(btrim(operation_key)) > 0),
  attempt_id text NOT NULL CHECK (length(btrim(attempt_id)) > 0),
  request_hash text NOT NULL CHECK (length(btrim(request_hash)) > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  decision text NOT NULL CHECK (decision IN ('reserved','kill_switch','budget_exhausted')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Za-z0-9][A-Za-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT,
  UNIQUE (session_id, run_id, operation_key),
  UNIQUE (session_id, run_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS synthetic_admission_decisions_run_idx
  ON synthetic_admission_decisions(session_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS synthetic_admission_decisions_policy_idx
  ON synthetic_admission_decisions(policy_id, created_at) WHERE policy_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS synthetic_reconciliation_controls (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  session_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','leased','resolved','failed','dead')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  last_result_code text CHECK (last_result_code IS NULL OR last_result_code ~ '^[A-Za-z0-9][A-Za-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, run_id, attempt_id) REFERENCES payment_attempts(session_id, run_id, id) ON DELETE RESTRICT,
  UNIQUE (session_id, run_id, attempt_id),
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS synthetic_reconciliation_controls_due_idx
  ON synthetic_reconciliation_controls(state, next_check_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS synthetic_reconciliation_controls_owner_idx
  ON synthetic_reconciliation_controls(session_id, run_id, attempt_id);

CREATE TABLE IF NOT EXISTS acp_checkout_documents (
  checkout_id text PRIMARY KEY REFERENCES checkouts(id) ON DELETE RESTRICT,
  subject text NOT NULL CHECK (length(btrim(subject)) > 0),
  session_id text NOT NULL,
  run_id text NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, run_id) REFERENCES runs(session_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, run_id, checkout_id) REFERENCES checkouts(session_id, run_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS acp_checkout_documents_owner_idx
  ON acp_checkout_documents(subject, session_id, run_id, checkout_id);

CREATE OR REPLACE FUNCTION reserve_synthetic_budget(
  p_id text,
  p_environment text,
  p_policy_id text,
  p_session_id text,
  p_run_id text,
  p_operation_key text,
  p_attempt_id text,
  p_request_hash text,
  p_amount_minor bigint
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  existing synthetic_admission_decisions%ROWTYPE;
  control safety_controls%ROWTYPE;
  policy synthetic_budget_policies%ROWTYPE;
  reserved_counter synthetic_budget_counters%ROWTYPE;
BEGIN
  IF p_amount_minor < 0 THEN
    RAISE EXCEPTION 'amount_minor must be non-negative' USING ERRCODE = '22023';
  END IF;

  -- Serialize admission identity and ownership checks per run before replay lookup.
  PERFORM 1 FROM runs WHERE session_id = p_session_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run not found in session scope' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO existing
    FROM synthetic_admission_decisions
   WHERE session_id = p_session_id AND run_id = p_run_id
     AND (operation_key = p_operation_key OR attempt_id = p_attempt_id)
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    IF existing.operation_key = p_operation_key
       AND existing.attempt_id = p_attempt_id
       AND existing.request_hash = p_request_hash
       AND existing.amount_minor = p_amount_minor
       AND existing.requested_policy_id = p_policy_id
       AND existing.environment = p_environment THEN
      RETURN jsonb_build_object(
        'status',CASE WHEN existing.decision = 'reserved' THEN 'replay' ELSE existing.decision END,
        'record',to_jsonb(existing)
      );
    END IF;
    RETURN jsonb_build_object('status','conflict');
  END IF;

  SELECT * INTO control FROM safety_controls
   WHERE environment = p_environment FOR UPDATE;
  IF NOT FOUND OR control.payment_admission_enabled IS NOT TRUE THEN
    INSERT INTO synthetic_admission_decisions(
      id,environment,requested_policy_id,session_id,run_id,operation_key,attempt_id,
      request_hash,amount_minor,decision,reason_code
    ) VALUES (
      p_id,p_environment,p_policy_id,p_session_id,p_run_id,p_operation_key,p_attempt_id,
      p_request_hash,p_amount_minor,'kill_switch',COALESCE(control.reason_code,'missing_control')
    );
    RETURN jsonb_build_object('status','kill_switch');
  END IF;

  SELECT * INTO policy FROM synthetic_budget_policies
   WHERE id = p_policy_id AND environment = p_environment AND enabled IS TRUE
     AND now() >= window_starts_at AND now() < window_ends_at
     AND (
       (scope_type = 'environment' AND session_id IS NULL AND run_id IS NULL) OR
       (scope_type = 'session' AND session_id = p_session_id AND run_id IS NULL) OR
       (scope_type = 'run' AND session_id = p_session_id AND run_id = p_run_id)
     )
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO synthetic_admission_decisions(
      id,environment,requested_policy_id,session_id,run_id,operation_key,attempt_id,
      request_hash,amount_minor,decision,reason_code
    ) VALUES (
      p_id,p_environment,p_policy_id,p_session_id,p_run_id,p_operation_key,p_attempt_id,
      p_request_hash,p_amount_minor,'budget_exhausted','policy_unavailable'
    );
    RETURN jsonb_build_object('status','budget_exhausted');
  END IF;

  INSERT INTO synthetic_budget_counters(policy_id) VALUES (policy.id)
  ON CONFLICT (policy_id) DO NOTHING;

  UPDATE synthetic_budget_counters
     SET consumed_amount_minor = consumed_amount_minor + p_amount_minor,
         consumed_attempt_count = consumed_attempt_count + 1,
         updated_at = now()
   WHERE policy_id = policy.id
     AND consumed_amount_minor + p_amount_minor <= policy.maximum_amount_minor
     AND consumed_attempt_count + 1 <= policy.attempt_ceiling
   RETURNING * INTO reserved_counter;

  IF NOT FOUND THEN
    INSERT INTO synthetic_admission_decisions(
      id,environment,requested_policy_id,policy_id,session_id,run_id,operation_key,
      attempt_id,request_hash,amount_minor,decision,reason_code
    ) VALUES (
      p_id,p_environment,p_policy_id,policy.id,p_session_id,p_run_id,p_operation_key,
      p_attempt_id,p_request_hash,p_amount_minor,'budget_exhausted','budget_exhausted'
    );
    RETURN jsonb_build_object('status','budget_exhausted');
  END IF;

  INSERT INTO synthetic_admission_decisions(
    id,environment,requested_policy_id,policy_id,session_id,run_id,operation_key,
    attempt_id,request_hash,amount_minor,decision,reason_code
  ) VALUES (
    p_id,p_environment,p_policy_id,policy.id,p_session_id,p_run_id,p_operation_key,
    p_attempt_id,p_request_hash,p_amount_minor,'reserved','reserved'
  ) RETURNING * INTO existing;

  RETURN jsonb_build_object('status','reserved','record',to_jsonb(existing));
END;
$$;

COMMIT;
