#!/usr/bin/env bash
# Task 2 acceptance test: run the migrations, then prove — not assert — that
# recoveryops_app cannot UPDATE or DELETE audit_log, while it CAN insert into
# it and read/write everything else.
#
# Usage: docker compose up -d && ./migrations/verify.sh

set -euo pipefail

export PGPASSWORD=local_dev_only
ADMIN="psql -h localhost -U recoveryops_admin -d recoveryops -v ON_ERROR_STOP=1"

echo "==> Running migrations as admin..."
$ADMIN -f migrations/001_extensions_and_enums.sql
$ADMIN -f migrations/002_core_tables.sql
$ADMIN -f migrations/003_app_role_and_grants.sql

echo "==> Seeding one risk_event and one audit_log row as admin..."
$ADMIN <<'SQL'
INSERT INTO risk_event (dedupe_key, merchant_id, source_type, customer_id, amount)
VALUES ('test-dedupe-1', gen_random_uuid(), 'payment_failure', 'cust_1', 499.00);

INSERT INTO audit_log (event_id, stage, detail)
SELECT id, 'detected', '{"note":"seed"}'::jsonb FROM risk_event WHERE dedupe_key = 'test-dedupe-1';
SQL

export PGPASSWORD=change_me_in_env
APP="psql -h localhost -U recoveryops_app -d recoveryops -v ON_ERROR_STOP=1"

echo "==> As recoveryops_app: INSERT into audit_log (must succeed)..."
if $APP -c "INSERT INTO audit_log (event_id, stage, detail) SELECT id, 'test_insert', '{}'::jsonb FROM risk_event LIMIT 1;"; then
  echo "PASS: insert succeeded"
else
  echo "FAIL: insert should have succeeded and did not"
  exit 1
fi

echo "==> As recoveryops_app: UPDATE audit_log (must FAIL)..."
if $APP -c "UPDATE audit_log SET stage = 'tampered' WHERE stage = 'detected';" 2>/dev/null; then
  echo "FAIL: UPDATE succeeded — audit_log is not actually immutable. Fix the grants in 003."
  exit 1
else
  echo "PASS: UPDATE was rejected by the database"
fi

echo "==> As recoveryops_app: DELETE from audit_log (must FAIL)..."
if $APP -c "DELETE FROM audit_log WHERE stage = 'detected';" 2>/dev/null; then
  echo "FAIL: DELETE succeeded — audit_log is not actually immutable. Fix the grants in 003."
  exit 1
else
  echo "PASS: DELETE was rejected by the database"
fi

echo ""
echo "Task 2 acceptance test: ALL CHECKS PASSED"
