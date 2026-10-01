-- DISPOSABLE TEST DATABASES ONLY. Runtime rollback is additive and retains nonce audit records.
BEGIN;
DROP FUNCTION IF EXISTS consume_jit_nonce(text,text,text,text,text,text,text,text,text,timestamptz,timestamptz);
DROP TABLE IF EXISTS jit_nonce_consumptions;
COMMIT;
