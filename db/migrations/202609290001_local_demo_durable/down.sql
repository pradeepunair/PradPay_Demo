-- DISPOSABLE TEST DATABASES ONLY. Live rollback retains payment evidence.
BEGIN;
DROP TABLE IF EXISTS local_demo_attempt_journals;
DROP TABLE IF EXISTS local_demo_journeys;
COMMIT;
