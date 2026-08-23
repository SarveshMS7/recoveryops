---
activation: always_on
---

# RecoveryOps — Project Rules

PROJECT: RecoveryOps — AI Revenue Recovery agent (Razorpay hackathon track)

## STACK — use exactly this, nothing else, unless a task explicitly says otherwise
- Backend: TypeScript / Node.js
- Database: PostgreSQL only. No other datastore.
- Queue/eventing: Postgres outbox table + polling worker. Do NOT introduce Kafka, RabbitMQ, SQS, or any message broker.
- Idempotency/locking: Postgres unique constraints + transactions. Do NOT introduce Redis, Redlock, or any distributed lock manager.
- Policy engine: hand-written rule evaluator reading policy.yaml. Do NOT introduce Open Policy Agent or any policy DSL/engine.
- ML scoring: offline-trained logistic regression (Python/scikit-learn) exported as coefficients.json, applied at runtime with plain arithmetic in Node. Do NOT introduce a live model-serving service, a deep learning framework, or a Python runtime dependency in the request path.
- Frontend: React + Tailwind + Recharts. No other UI framework.
- Testing: Vitest, Testcontainers or docker-compose Postgres for integration tests.
- Deployment target: a single container + a managed Postgres instance. No Kubernetes, no service mesh, no multi-service split.

## ARCHITECTURE — hexagonal (ports & adapters). Enforce this structure
- `domain/` → pure business logic. NEVER import a database client, HTTP client, or SDK here. No exceptions. (Enforced by eslint.config.js's no-restricted-imports rule on this folder — if that rule fires, fix the code, do not suppress it.)
- `ports/` → interfaces only (event_repository, payment_gateway, notification_gateway, llm_client, event_bus).
- `adapters/` → concrete implementations of ports (postgres/, razorpay/, llm/, outbox/, mock/).
- `application/` → orchestration only; wires ports together, calls domain/ functions. No business logic lives here.
- `api/`, `worker/` → thin entrypoints. They call application/ and nothing else.

## HARD RULES — violating any of these is a failed task, not a stylistic choice
1. Every money-affecting action MUST go through an idempotency key backed by a Postgres unique constraint.
2. The LLM client (ports/llm_client) may only return a value from a closed enum of allowed actions. Never execute free-text or LLM-generated code/commands.
3. The policy engine, not the LLM, is the final gate before any execution. No task may let an LLM call payment_gateway directly.
4. Every RiskEvent-derived table carries merchant_id, even with a single synthetic merchant.
5. The audit_log table must never receive UPDATE or DELETE grants from the application's DB role — append-only, enforced at the database permission level.
6. If a task seems to require Kafka/Redis/OPA/a second language runtime/a microservice split to complete "properly," STOP and ask instead of adding it. State the constraint you're stuck on rather than working around this rules file.

## Definition of done
A task is not complete until the relevant test suite has actually been run and its output shown. Do not report a task as done based on the code looking correct — run it and show the result.

## Reference
See `ARCHITECTURE.md` at the project root for the full data model, state diagram, and system diagram this project implements.
See `TASKS.md` at the project root for the full task breakdown, current progress (✅/⬜), and each task's "done when" acceptance condition. Always check which tasks are already ✅ before starting work, and update the status in TASKS.md when a task is genuinely verified done — not before.
