# RecoveryOps

AI Revenue Recovery agent — Razorpay hackathon, Track 03.

Detects revenue-at-risk events (payment failures, checkout abandonment, failed
subscriptions), scores and allocates limited recovery capacity under budget,
executes bounded and idempotent recovery actions through Razorpay, and proves
recovery was incremental via a held-out control group — not just a headline
number.

## Status

Scaffold only (Task 1). No business logic yet.

## Architecture

Hexagonal (ports & adapters). See `docs/adr/` for the non-obvious decisions
and their rationale, and `ARCHITECTURE.md` (added in Task 2) for the data
model and state diagram.

```
domain/        pure business logic — no I/O, no framework, no SDK imports
ports/         interfaces only
adapters/      concrete implementations (postgres/, razorpay/, llm/, outbox/, mock/)
application/   orchestration — wires ports together, calls domain/
api/, worker/  thin entrypoints
ml/            offline model training (not part of the request path)
```

## Setup

```
npm install
npm run build
npm run lint
npm test
```

## Rules

See the project's persistent rules/steering config for the standing
constraints (stack choices, hard rules on idempotency/policy-gating/audit
immutability). Every task must respect them.
