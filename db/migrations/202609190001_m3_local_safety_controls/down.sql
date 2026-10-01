-- DESTRUCTIVE: uniquely named disposable test databases only.
-- Operational rollback keeps M3 safety, admission, and reconciliation records.
BEGIN;
DROP FUNCTION IF EXISTS reserve_synthetic_budget(text,text,text,text,text,text,text,text,bigint);
DROP TABLE IF EXISTS acp_checkout_documents;
DROP TABLE IF EXISTS synthetic_reconciliation_controls;
DROP TABLE IF EXISTS synthetic_admission_decisions;
DROP TABLE IF EXISTS synthetic_budget_counters;
DROP TABLE IF EXISTS synthetic_budget_policies;
DROP TABLE IF EXISTS safety_controls;
COMMIT;
