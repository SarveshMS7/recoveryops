-- 001_extensions_and_enums.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

CREATE TYPE source_type AS ENUM ('payment_failure', 'checkout_abandon', 'subscription', 'receivable');
CREATE TYPE risk_group AS ENUM ('treatment', 'control');
CREATE TYPE selected_action AS ENUM ('retry_now', 'retry_delayed', 'send_reminder', 'offer_alt_method', 'escalate', 'none');
CREATE TYPE policy_check_name AS ENUM ('retry_limit', 'cooldown', 'spend_cap', 'compliance_window');
CREATE TYPE execution_result AS ENUM ('success', 'failed', 'timeout');
