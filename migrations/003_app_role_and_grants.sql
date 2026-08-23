-- 003_app_role_and_grants.sql
--
-- Enforces audit-log immutability at the database permission level, not just
-- by application convention. The app role can SELECT and INSERT everywhere,
-- but has no UPDATE or DELETE grant on audit_log at all — so even a bug in
-- application code cannot silently mutate or erase an audit entry.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'recoveryops_app') THEN
    CREATE ROLE recoveryops_app LOGIN PASSWORD 'change_me_in_env';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO recoveryops_app;

-- Full read/write on everything except audit_log
GRANT SELECT, INSERT, UPDATE, DELETE ON
  risk_event, score, decision, policy_check, action_execution, outbox
  TO recoveryops_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO recoveryops_app;

-- audit_log: insert and read only. No UPDATE. No DELETE.
GRANT SELECT, INSERT ON audit_log TO recoveryops_app;
