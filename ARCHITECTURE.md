# RecoveryOps — Architecture Reference

## Data Model

```
RiskEvent
  id                 uuid, primary key
  dedupe_key         text, unique — source + external_ref (e.g. razorpay payment_id)
  merchant_id        uuid, not null
  source_type        enum: payment_failure | checkout_abandon | subscription | receivable
  customer_id        text
  amount             numeric, not null
  currency           text, not null, default 'INR'
  raw_reason         text — gateway decline code / cart stage / etc.
  detected_at        timestamptz, not null, default now()
  "group"            enum: treatment | control — set once at scoring time, never changes

Score
  event_id           uuid, references RiskEvent(id)
  p_loss             numeric
  p_uplift           numeric
  expected_value     numeric
  cost_estimate      numeric
  scored_at          timestamptz, default now()

Decision
  event_id           uuid, references RiskEvent(id)
  root_cause_summary text
  selected_action    enum: retry_now | retry_delayed | send_reminder | offer_alt_method | escalate | none
  rationale          text
  decided_at         timestamptz, default now()

PolicyCheck
  event_id           uuid, references RiskEvent(id)
  check_name         enum: retry_limit | cooldown | spend_cap | compliance_window
  passed             boolean, not null
  detail             text
  checked_at         timestamptz, default now()

ActionExecution
  event_id           uuid, references RiskEvent(id)
  idempotency_key    text, unique, not null — event_id + attempt_number
  action             text, not null
  attempt_number     integer, not null
  result             enum: success | failed | timeout
  executed_at        timestamptz, default now()

Outbox
  id                 uuid, primary key
  event_id           uuid, references RiskEvent(id)
  payload            jsonb
  published          boolean, default false
  created_at         timestamptz, default now()
  published_at       timestamptz

AuditLog   (append-only — no UPDATE/DELETE grant on the app role)
  id                 uuid, primary key
  event_id           uuid
  stage              text        — e.g. 'detected', 'scored', 'policy_checked', 'executed'
  detail             jsonb
  occurred_at        timestamptz, default now()
```

Every table above except Outbox and AuditLog (which key off `event_id`, itself already merchant-scoped) carries `merchant_id` directly or transitively, even with a single synthetic merchant in the hackathon build.

## State Machine

```
Detected
  → Scored
      → Parked_Control        (holdout group; no action taken; tracked for measurement)
      → Skipped               (treatment group, but not funded by the allocator's budget)
      → Allocated             (treatment group, funded)
          → ActionSelected
              → PolicyRejected → Escalated
              → PolicyApproved
                  → Executing
                      → Succeeded
                      → Failed
                          → Executing   (retry, if under limit and cooldown elapsed)
                          → Stopped     (retry limit reached)
                          → Escalated   (hard/non-retryable decline)
```

Illegal transitions (e.g. `Succeeded → Executing`, `Stopped → Executing`) must raise, not silently no-op.

## System Diagram

```
Sources (payment_failure, checkout_abandon, subscription feeds — synthetic)
  → Event Normalizer → one RiskEvent schema
  → Dedupe check (unique dedupe_key)
  → [Postgres transaction: write RiskEvent + Outbox row together]
  → Outbox Poller (polls unsent rows, publishes, marks sent)
  → Scoring Service (logistic model: p_loss, p_uplift → expected_value)
  → Holdout Splitter (~10% → control, rest → treatment)
  → Allocator (greedy by expected_value/cost, under a fixed budget)
  → Decision (LLM proposes root cause + action FROM FIXED ENUM ONLY)
  → Policy Engine (policy.yaml: retry limit / cooldown / spend cap / compliance window)
  → Executor (idempotency key = event_id + attempt_number, unique DB constraint)
  → Razorpay test-mode APIs / mocked comms adapter
  → Result → Recovered, or State Machine retry/stop/escalate
  → Audit Log (append-only) → Dashboard (funnel, audit timeline, incrementality)
```

## Non-obvious decisions (see docs/adr/ for the full write-ups)
- Postgres-as-queue instead of a message broker
- Greedy allocator instead of a constraint solver
- Offline logistic regression instead of a heavier model
- LLM output is a closed enum, never free text, on the money-decision path
