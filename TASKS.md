# RecoveryOps — Task List

Feed one task at a time. Each has a concrete "done when" condition — a task
is not complete until its test suite has actually been run and shown, per
the standing rule in `.agents/rules/recoveryops.md`.

Status legend: ✅ done and verified · ⬜ not started

---

## Foundation

**✅ Task 1 — Repo scaffold**
Folder structure, package.json, tsconfig, eslint config (including the
`no-restricted-imports` rule on `domain/`), placeholder `domain/index.ts`.
Verified: `npm install && npm run build` succeeds.

**✅ Task 2 — Postgres schema + migrations**
Migrations for risk_event, score, decision, policy_check, action_execution,
outbox, audit_log, matching `ARCHITECTURE.md` exactly. `recoveryops_app` role
has no UPDATE/DELETE grant on audit_log.
Verified: `./migrations/verify.sh` — all three checks (insert allowed,
update rejected, delete rejected) passed against a real Postgres instance.

**✅ Task 3 — Domain entities + state machine**
Implement `domain/state_machine.ts` exactly matching the transition diagram
in `ARCHITECTURE.md` (Detected → Scored → Parked_Control/Skipped/Allocated →
ActionSelected → PolicyApproved/PolicyRejected → Executing →
Succeeded/Failed→{retry|Stopped|Escalated}). Illegal transitions must throw.
**Done when:** a table-driven unit test in `tests/unit/state_machine.test.ts`
covers every legal transition and at least one illegal transition per state,
passes with zero I/O (no database, no network calls in this test file), and
you've actually run it and seen the output.
Verified: `npx vitest run` — 64 tests passed (0 failed), zero I/O, 12ms.

**✅ Task 3.5 — Synthetic data generator**
Write a generator (e.g. `ml/generate_synthetic_data.ts` or a script in
`ml/`) producing synthetic `payment_failure` and `checkout_abandon` events
matching the `RiskEvent` schema in `ARCHITECTURE.md`. Include at minimum:
amount, days-overdue/cart-stage, decline-reason category (retryable vs not),
prior retry attempts, and a simple issuer/customer history field. Critically:
the outcome label (did this event eventually recover) must be generated so
it's **correlated with these features**, not independent noise — e.g. bias
recovery probability upward for retryable declines, low prior attempts, and
good issuer history, with randomness layered on top, not instead of signal.
If labels are independent of features, Task 18's model will honestly report
near-chance accuracy, which is a worse outcome than not training a model at
all.
**Done when:** generating 500 synthetic events produces a labeled dataset
where a naive baseline (e.g. always-predict-majority-class) is clearly
beaten by even a rough manual rule using the features above — sanity-check
this by hand before Task 18 trains on it.
Verified: `npx tsx ml/generate_synthetic_data.ts` — 500 events generated to
`ml/synthetic_events.json`. Manual rule accuracy 58.8% beats majority-class
baseline 55.0% (+3.8pp). Features clearly correlated: retryable 58.1% vs
non-retryable 29.4%, low attempts 61.2% vs high 36.7%.

---

## Core logic (pure functions — no adapters needed yet)

**✅ Task 4 — Policy engine**
`domain/policy.ts`: pure function `(event, policyConfig) -> {passed, reason}`
reading retry limit, cooldown, spend cap, and compliance window rules from
`config/policy.yaml` (shape defined in `config/policy.schema.json`).
**Done when:** boundary tests pass for all four rule types — exactly-at-limit
vs one-over, just-before vs just-after cooldown elapsed, exactly-at-cap vs
one-rupee-over, inside vs outside the compliance window.
Verified: `npx vitest run tests/unit/policy.test.ts` — 28 tests passed
(0 failed). Boundary cases: at-limit=pass/one-over=fail, just-after=pass/
just-before=fail, at-cap=pass/one-rupee-over=fail, inside=pass/outside=fail.

**✅ Task 5 — Allocator**
`domain/allocator.ts`: given `{event_id, expected_value, cost}[]` and a
budget, return the selected set via greedy sort by expected_value/cost
descending, until budget is exhausted.
**Done when:** a test with a fixed, known input list asserts the *exact*
selected set and *exact* skipped set — not an approximate check.
Verified: `npx vitest run tests/unit/allocator.test.ts` — 12 tests passed
(0 failed). Fixed input [A,B,C,D,E] with budget 350 → exact allocated
[C,A,D], exact skipped [E,B], plus edge cases.

**✅ Task 6 — Scoring function**
`domain/scoring.ts`: pure function taking an event's feature vector + a
coefficients object, returning p_loss, p_uplift, expected_value via
dot-product + sigmoid. Coefficients are injected, not hardcoded.
**Coefficients shape (matches Task 18's output exactly — do not deviate):**
```ts
type Coefficients = {
  intercept: number;
  weights: number[];       // ordered array, same order as feature_order
  feature_order: string[]; // names, for documentation/debugging only —
                            // runtime code must index weights[] by position,
                            // never look up by name
};
```
**Done when:** unit test with known coefficients and known input produces
the exact expected output value, computed independently (e.g. by hand or in
a spreadsheet) and hardcoded as the assertion.
Verified: `npx vitest run tests/unit/scoring.test.ts` — 19 tests passed
(0 failed). Golden values: intercept=0.5, weights=[0.3,-0.2,0.8],
features=[1.0,2.0,0.5], amount=5000 → p_loss≈0.6899745, p_uplift≈0.4501660,
expected_value≈1553.015 (hand-computed, hardcoded assertions).

---

## Ports and mock adapters (unblocks parallel work)

**✅ Task 7 — Define all ports**
Interfaces only in `ports/`: event_repository, payment_gateway,
notification_gateway, llm_client, event_bus.
**Done when:** it compiles and every method used anywhere else in the plan
has a signature here.
Verified: `npx tsc -p tsconfig.json --noEmit` — zero errors. All five
ports defined with full method signatures in `ports/`. Shared types in
`ports/types.ts`, barrel export in `ports/index.ts`.

**✅ Task 8 — Mock adapters**
`adapters/mock/`: in-memory fakes for every port, including a configurable
failure-injection flag (e.g. `mockGateway.forceFailureFor(eventId, times)`).
**Done when:** application-layer code can run entirely against mocks with
zero real network/DB calls, and a smoke test proves it.
Verified: `npx vitest run` — 135 tests passed (0 failed), including 12
new smoke tests in `tests/unit/mock_adapters.test.ts` covering full
pipeline flow, dedupe, idempotency, failure injection for all 5 ports,
LLM enum validation, event bus dispatch, and outbox lifecycle — zero I/O.

---

## Application layer (orchestration, tested against mocks first)

**✅ Task 9 — Ingest + dedupe + outbox write**
`application/ingest_event.ts`: normalize, dedupe on `dedupe_key`, write
`risk_event` + `outbox` row in a single transaction.
**Done when:** integration test against real Postgres proves a duplicate
dedupe_key produces exactly one risk_event row, and a simulated write
failure mid-transaction leaves no partial row.
Verified: `npx vitest run tests/integration/ingest_event.test.ts` — 4 tests
passed (0 failed). Duplicate dedupe_key → exactly 1 row. Transaction
rollback mid-write → 0 rows (no partial data). Concurrent 5x ingest →
exactly 1 row. Full suite: 139 tests passed.

**✅ Task 10 — Outbox poller**
`adapters/outbox/poller.ts` implementing `event_bus`: polls unsent rows,
publishes, marks sent.
**Done when:** integration test proves a poller crash mid-batch, restarted,
does not re-publish already-sent rows and does eventually publish the rest.
Verified: `npx vitest run tests/integration/outbox_poller.test.ts` — 4 tests
passed (0 failed). Crash-mid-batch: 2 rows published before crash stay
published, restarted poller picks up only remaining 3 rows, no re-publish
of already-sent rows. Full suite: 139 tests passed.

**✅ Task 11 — Scoring + allocation pass**
`application/run_scoring_pass.ts` / `run_allocation_pass.ts` wiring
`domain/scoring.ts` and `domain/allocator.ts` against the event repository
port, including the ~10% holdout split (tracked via the `group` column).
**Done when:** integration test on a seeded batch confirms every event ends
up in exactly one of {control, skipped, allocated} — no overlaps, no
omissions.
Verified: `npx vitest run tests/integration/scoring_allocation.test.ts` —
2 tests passed (0 failed). 20 seeded events: each scored, group-assigned,
then placed into exactly one of {Parked_Control, Allocated, Skipped} with
zero overlaps and zero omissions. Budget constraints respected. Empty
batch handled gracefully. Full suite: 137 tests passed.

**✅ Task 12 — Decision + policy + execution**
`application/execute_decision.ts`: call `llm_client` for root cause + action
(validated against the closed enum before use), run through
`domain/policy.ts`, then call `payment_gateway`, using
idempotency_key = event_id + attempt_number.
**Done when:** integration test proves calling execute twice with the same
idempotency_key produces exactly one successful `action_execution` row, and
an LLM mock returning a value outside the enum is rejected before reaching
the policy engine.
Verified: `npx vitest run tests/integration/execute_decision.test.ts` —
4 tests passed (0 failed). Duplicate idempotency_key → exactly 1 row.
Invalid LLM action "hack_the_mainframe" rejected with InvalidLlmActionError
before policy engine (0 policy checks, 0 executions). Policy rejection →
Escalated. Full suite: 139 tests passed.

---

## Real adapters

**⬜ Task 13 — Razorpay adapter** (payment_gateway, against test-mode APIs)
**⬜ Task 14 — LLM adapter** (llm_client, closed-enum-constrained)
**Done when (both):** the same integration tests from Task 12 pass
unmodified against the real adapter instead of the mock. If they don't pass
unmodified, the port interface was leaky — fix the boundary, not the test.

---

## Chaos tests (use the mock's failure-injection flag from Task 8)

**⬜ Task 15 — Retry-then-stop**
Force failure on attempts 1–2; assert the state machine reaches `Stopped`
after the configured limit, not further retries.

**⬜ Task 16 — Concurrent execution / idempotency**
Fire two simultaneous `execute_decision` calls for one event; assert exactly
one `Succeeded` row exists afterward.

**⬜ Task 17 — Duplicate inbound event**
Fire the same normalized payload twice through `ingest_event`; assert
exactly one `risk_event` row exists.

---

## Model + rigor (Week 2)

**⬜ Task 18 — Offline training script**
Python script in `ml/` (scikit-learn): train a logistic regression on the
Task 3.5 synthetic dataset, do a real train/test split, output
`ml/coefficients.json` **matching the shape defined in Task 6 exactly**
(`{intercept, weights: [...], feature_order: [...]}` — ordered array, not a
name-keyed dict) plus `ml/metrics.md` with real precision/recall/AUC from
the held-out split.
**Done when:** `ml/metrics.md` contains real numbers from a real held-out
split, and a golden-value test in `tests/unit/scoring.test.ts` confirms the
Node runtime scorer produces the same output as the Python model on an
identical input.

**⬜ Task 19 — Second detector: failed-subscription**
New `source_type` through the existing Event Normalizer, own synthetic
feed, reusing every downstream component unmodified.
**Done when:** it flows through the entire pipeline with zero changes to
`domain/`, `ports/`, or `application/` — only a new adapter/source and a
normalizer mapping. Any downstream change needed is a signal the port
boundary was wrong; fix the boundary, not the rule.

---

## Multi-tenancy, CI, dashboard, deploy

**⬜ Task 20 — Postgres RLS** *(lowest priority — cut this first under time
pressure; it doesn't move any of the four judged criteria on its own. Keep
`merchant_id` on every table regardless — that part is free.)*
Row-level security policies scoped by merchant_id.
**Done when:** a test creates two merchants and proves a query scoped to
merchant A cannot return merchant B's rows even via a raw query attempt.

**⬜ Task 21 — CI**
GitHub Actions: job 1 (lint + typecheck + unit tests) on every PR; job 2
(integration tests against a Postgres service container) on merge to main.

**⬜ Task 22 — Dashboard**
React app: funnel view (detected/scored/allocated/skipped/parked/succeeded),
audit timeline for a selected event, incrementality panel (treatment vs
control recovery rate).

**⬜ Task 23 — Deploy** *(optional — a live URL is nice for judges but a
well-run local demo scores the same on every rubric criterion)*
docker-compose for local (already exists from Task 2); deploy config for
Render/Fly/Railway with seeded demo data.
