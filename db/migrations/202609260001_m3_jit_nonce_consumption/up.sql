BEGIN;

-- JIT receipt nonce consumption stores binding metadata only; never credentials or provider payloads.
CREATE TABLE IF NOT EXISTS jit_nonce_consumptions (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{64}$'),
  candidate_commit text NOT NULL CHECK (candidate_commit ~ '^[a-f0-9]{40}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  endpoint text NOT NULL CHECK (length(btrim(endpoint)) > 0),
  account_id text NOT NULL CHECK (length(btrim(account_id)) > 0),
  payment_method_fingerprint text NOT NULL CHECK (payment_method_fingerprint ~ '^[a-f0-9]{64}$'),
  api_version text NOT NULL CHECK (length(btrim(api_version)) > 0),
  acp_version text NOT NULL CHECK (length(btrim(acp_version)) > 0),
  operator_identity text NOT NULL CHECK (length(btrim(operator_identity)) > 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'consumed' CHECK (status = 'consumed'),
  CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS jit_nonce_consumptions_retention_idx
  ON jit_nonce_consumptions(consumed_at);

-- The unique primary-key insert is the single-winner replay boundary. Callers must invoke it
-- in a transaction and commit before credential access or provider dispatch.
CREATE OR REPLACE FUNCTION consume_jit_nonce(
  p_nonce text,
  p_candidate_commit text,
  p_request_hash text,
  p_endpoint text,
  p_account_id text,
  p_payment_method_fingerprint text,
  p_api_version text,
  p_acp_version text,
  p_operator_identity text,
  p_issued_at timestamptz,
  p_expires_at timestamptz
) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO jit_nonce_consumptions(
    nonce,candidate_commit,request_hash,endpoint,account_id,
    payment_method_fingerprint,api_version,acp_version,operator_identity,
    issued_at,expires_at
  ) VALUES (
    p_nonce,p_candidate_commit,p_request_hash,p_endpoint,p_account_id,
    p_payment_method_fingerprint,p_api_version,p_acp_version,p_operator_identity,
    p_issued_at,p_expires_at
  ) ON CONFLICT (nonce) DO NOTHING;
  IF FOUND THEN RETURN 'consumed'; END IF;
  RETURN 'replay';
END;
$$;

COMMIT;
