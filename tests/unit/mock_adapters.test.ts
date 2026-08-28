/**
 * Smoke test: proves application-layer code can run entirely against
 * mock adapters with zero real network/DB calls.
 *
 * Exercises the complete flow:
 *   1. Ingest an event (via MockEventRepository)
 *   2. Score it (via domain/scoring.ts + MockEventRepository)
 *   3. Allocate it (via domain/allocator.ts)
 *   4. Get LLM decision (via MockLlmClient)
 *   5. Run policy check (via domain/policy.ts)
 *   6. Execute action (via MockPaymentGateway)
 *   7. Publish domain events (via MockEventBus)
 *   8. Send notification (via MockNotificationGateway)
 *   9. Write audit log entries
 *
 * Also tests:
 *   - Dedupe (same dedupe_key → null on second insert)
 *   - Idempotency (same idempotency_key → null on second execution)
 *   - Failure injection (forceFailureFor produces failures, then recovers)
 *   - LLM enum validation (invalid action → throw)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MockEventRepository,
  MockPaymentGateway,
  MockNotificationGateway,
  MockLlmClient,
  MockEventBus,
} from "../../adapters/mock/index.js";
import { score } from "../../domain/scoring.js";
import { allocate } from "../../domain/allocator.js";
import { evaluatePolicy } from "../../domain/policy.js";
import { transition, EventState } from "../../domain/state_machine.js";
import type { Coefficients, ScoreInput } from "../../domain/scoring.js";
import type { PolicyConfig, PolicyEventContext } from "../../domain/policy.js";

// ── Test fixtures ──────────────────────────────────────────────────

const TEST_MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_CUSTOMER_ID = "cust_test_123";

const TEST_COEFFICIENTS: Coefficients = {
  intercept: 0.5,
  weights: [0.3, -0.2, 0.8],
  feature_order: ["feature_a", "feature_b", "feature_c"],
};

const TEST_POLICY_CONFIG: PolicyConfig = {
  retry_limit: { max_attempts: 3 },
  cooldown: { min_interval_seconds: 3600 },
  spend_cap: { daily_limit_inr: 100000 },
  compliance_window: { start_hour: 8, end_hour: 21 },
};

// ── Mocks ──────────────────────────────────────────────────────────

let repo: MockEventRepository;
let gateway: MockPaymentGateway;
let notifier: MockNotificationGateway;
let llm: MockLlmClient;
let bus: MockEventBus;

beforeEach(() => {
  repo = new MockEventRepository();
  gateway = new MockPaymentGateway();
  notifier = new MockNotificationGateway();
  llm = new MockLlmClient();
  bus = new MockEventBus();
});

// ── Tests ──────────────────────────────────────────────────────────

describe("Mock adapters smoke test — full flow with zero I/O", () => {
  it("should run a complete recovery pipeline against mocks", async () => {
    // 1. Ingest event
    const event = await repo.insertEventWithOutbox(
      {
        dedupe_key: "razorpay:pay_test_001",
        merchant_id: TEST_MERCHANT_ID,
        source_type: "payment_failure",
        customer_id: TEST_CUSTOMER_ID,
        amount: 5000,
        currency: "INR",
        raw_reason: "card_declined",
      },
      { type: "event_ingested", event_id: "pending" },
    );

    expect(event).not.toBeNull();
    const eventId = event!.id;

    // Verify event is persisted
    const found = await repo.findEventById(eventId);
    expect(found).not.toBeNull();
    expect(found!.amount).toBe(5000);

    // State: Detected → Scored
    let state: string = transition(EventState.Detected, EventState.Scored);
    await repo.updateState(eventId, state);

    // 2. Score event
    const features: ScoreInput = {
      features: [1.0, 2.0, 0.5],
      amount: 5000,
    };
    const scoreResult = score(TEST_COEFFICIENTS, features);
    expect(scoreResult.p_loss).toBeGreaterThan(0);
    expect(scoreResult.expected_value).toBeGreaterThan(0);

    await repo.insertScore({
      event_id: eventId,
      p_loss: scoreResult.p_loss,
      p_uplift: scoreResult.p_uplift,
      expected_value: scoreResult.expected_value,
      cost_estimate: 10,
    });

    // 3. Set group and allocate
    await repo.setGroup(eventId, "treatment");

    const allocation = allocate(
      [{ event_id: eventId, expected_value: scoreResult.expected_value, cost: 10 }],
      1000,
    );
    expect(allocation.allocated).toHaveLength(1);
    expect(allocation.allocated[0]!.event_id).toBe(eventId);

    // State: Scored → Allocated
    state = transition(EventState.Scored, EventState.Allocated);
    await repo.updateState(eventId, state);

    // 4. LLM decision
    const llmResponse = await llm.analyse({
      event_id: eventId,
      source_type: "payment_failure",
      amount: 5000,
      currency: "INR",
      raw_reason: "card_declined",
      attempt_count: 0,
      context: {},
    });

    expect(llmResponse.selected_action).toBe("retry_now");

    await repo.insertDecision({
      event_id: eventId,
      root_cause_summary: llmResponse.root_cause_summary,
      selected_action: llmResponse.selected_action,
      rationale: llmResponse.rationale,
    });

    // State: Allocated → ActionSelected
    state = transition(EventState.Allocated, EventState.ActionSelected);
    await repo.updateState(eventId, state);

    // 5. Policy check — use a time within the compliance window (10:00 IST = 04:30 UTC)
    const policyCtx: PolicyEventContext = {
      attempt_number: 1,
      last_attempt_at: null,
      action_cost_inr: 5000,
      merchant_daily_spend_inr: 0,
      now: new Date("2026-01-15T04:30:00Z"), // 10:00 IST
    };
    const policyResult = evaluatePolicy(TEST_POLICY_CONFIG, policyCtx);
    expect(policyResult.passed).toBe(true);

    for (const check of policyResult.checks) {
      await repo.insertPolicyCheck({
        event_id: eventId,
        check_name: check.check_name,
        passed: check.passed,
        detail: check.reason,
      });
    }

    // State: ActionSelected → PolicyApproved
    state = transition(EventState.ActionSelected, EventState.PolicyApproved);
    await repo.updateState(eventId, state);

    // State: PolicyApproved → Executing
    state = transition(EventState.PolicyApproved, EventState.Executing);
    await repo.updateState(eventId, state);

    // 6. Execute action
    const gatewayResponse = await gateway.executeAction({
      event_id: eventId,
      external_ref: "pay_test_001",
      action: "retry_now",
      amount: 500000, // paise
      currency: "INR",
      idempotency_key: `${eventId}:1`,
    });

    expect(gatewayResponse.result).toBe("success");

    await repo.insertActionExecution({
      event_id: eventId,
      idempotency_key: `${eventId}:1`,
      action: "retry_now",
      attempt_number: 1,
      result: gatewayResponse.result,
    });

    // State: Executing → Succeeded
    state = transition(EventState.Executing, EventState.Succeeded);
    await repo.updateState(eventId, state);

    // 7. Publish domain event
    await bus.publish({
      event_id: eventId,
      type: "recovery_succeeded",
      payload: { action: "retry_now" },
      occurred_at: new Date(),
    });
    expect(bus.published).toHaveLength(1);

    // 8. Send notification
    const notifResponse = await notifier.send({
      event_id: eventId,
      customer_id: TEST_CUSTOMER_ID,
      merchant_id: TEST_MERCHANT_ID,
      channel: "email",
      subject: "Payment recovered",
      body: "Your payment of ₹5,000 has been recovered.",
      idempotency_key: `notif:${eventId}:1`,
    });
    expect(notifResponse.sent).toBe(true);
    expect(notifier.sent).toHaveLength(1);

    // 9. Audit log
    await repo.insertAuditLog({
      event_id: eventId,
      stage: "executed",
      detail: { action: "retry_now", result: "success" },
    });
    const logs = await repo.findAuditLogsByEventId(eventId);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.stage).toBe("executed");

    // Final state
    const finalState = await repo.getCurrentState(eventId);
    expect(finalState).toBe("Succeeded");
  });

  it("should deduplicate events with the same dedupe_key", async () => {
    const first = await repo.insertEventWithOutbox(
      {
        dedupe_key: "razorpay:pay_dup",
        merchant_id: TEST_MERCHANT_ID,
        source_type: "payment_failure",
        customer_id: TEST_CUSTOMER_ID,
        amount: 1000,
        currency: "INR",
        raw_reason: null,
      },
      {},
    );
    expect(first).not.toBeNull();

    const second = await repo.insertEventWithOutbox(
      {
        dedupe_key: "razorpay:pay_dup",
        merchant_id: TEST_MERCHANT_ID,
        source_type: "payment_failure",
        customer_id: TEST_CUSTOMER_ID,
        amount: 1000,
        currency: "INR",
        raw_reason: null,
      },
      {},
    );
    expect(second).toBeNull(); // Deduplicated
  });

  it("should enforce idempotency on action execution", async () => {
    const event = await repo.insertEventWithOutbox(
      {
        dedupe_key: "razorpay:pay_idemp",
        merchant_id: TEST_MERCHANT_ID,
        source_type: "payment_failure",
        customer_id: TEST_CUSTOMER_ID,
        amount: 2000,
        currency: "INR",
        raw_reason: null,
      },
      {},
    );
    const eventId = event!.id;

    const first = await repo.insertActionExecution({
      event_id: eventId,
      idempotency_key: `${eventId}:1`,
      action: "retry_now",
      attempt_number: 1,
      result: "success",
    });
    expect(first).not.toBeNull();

    const second = await repo.insertActionExecution({
      event_id: eventId,
      idempotency_key: `${eventId}:1`,
      action: "retry_now",
      attempt_number: 1,
      result: "success",
    });
    expect(second).toBeNull(); // Idempotency enforced
  });

  it("should support failure injection on MockPaymentGateway", async () => {
    const eventId = "event-fail-test";
    gateway.forceFailureFor(eventId, 2);

    // First two calls fail
    const r1 = await gateway.executeAction({
      event_id: eventId,
      external_ref: "pay_x",
      action: "retry_now",
      amount: 100000,
      currency: "INR",
      idempotency_key: `${eventId}:1`,
    });
    expect(r1.result).toBe("failed");

    const r2 = await gateway.executeAction({
      event_id: eventId,
      external_ref: "pay_x",
      action: "retry_now",
      amount: 100000,
      currency: "INR",
      idempotency_key: `${eventId}:2`,
    });
    expect(r2.result).toBe("failed");

    // Third call succeeds
    const r3 = await gateway.executeAction({
      event_id: eventId,
      external_ref: "pay_x",
      action: "retry_now",
      amount: 100000,
      currency: "INR",
      idempotency_key: `${eventId}:3`,
    });
    expect(r3.result).toBe("success");

    // All three calls logged
    expect(gateway.calls).toHaveLength(3);
  });

  it("should support failure injection on MockEventRepository", async () => {
    const eventId = "event-repo-fail";
    repo.forceFailureFor(eventId, 1);

    // The mock generates its own IDs, so we test insertScore failure instead
    await expect(
      repo.insertScore({
        event_id: eventId,
        p_loss: 0.5,
        p_uplift: 0.3,
        expected_value: 100,
        cost_estimate: 10,
      }),
    ).rejects.toThrow("injected failure");
  });

  it("should support failure injection on MockLlmClient", async () => {
    const eventId = "event-llm-fail";
    llm.forceFailureFor(eventId, 1);

    await expect(
      llm.analyse({
        event_id: eventId,
        source_type: "payment_failure",
        amount: 1000,
        currency: "INR",
        raw_reason: null,
        attempt_count: 0,
        context: {},
      }),
    ).rejects.toThrow("injected failure");

    // Second call succeeds
    const response = await llm.analyse({
      event_id: eventId,
      source_type: "payment_failure",
      amount: 1000,
      currency: "INR",
      raw_reason: null,
      attempt_count: 0,
      context: {},
    });
    expect(response.selected_action).toBe("retry_now");
  });

  it("should reject LLM responses with invalid actions", async () => {
    const eventId = "event-bad-action";
    llm.setResponseFor(eventId, {
      root_cause_summary: "Test",
      selected_action: "launch_missiles" as never,
      rationale: "Bad action",
    });

    await expect(
      llm.analyse({
        event_id: eventId,
        source_type: "payment_failure",
        amount: 1000,
        currency: "INR",
        raw_reason: null,
        attempt_count: 0,
        context: {},
      }),
    ).rejects.toThrow("not in the closed enum");
  });

  it("should support failure injection on MockEventBus", async () => {
    const eventId = "event-bus-fail";
    bus.forceFailureFor(eventId, 1);

    await expect(
      bus.publish({
        event_id: eventId,
        type: "test_event",
        payload: {},
        occurred_at: new Date(),
      }),
    ).rejects.toThrow("injected failure");

    // Second publish succeeds
    await bus.publish({
      event_id: eventId,
      type: "test_event",
      payload: {},
      occurred_at: new Date(),
    });
    expect(bus.published).toHaveLength(1);
  });

  it("should support failure injection on MockNotificationGateway", async () => {
    const eventId = "event-notif-fail";
    notifier.forceFailureFor(eventId, 1);

    const r1 = await notifier.send({
      event_id: eventId,
      customer_id: "cust_1",
      merchant_id: TEST_MERCHANT_ID,
      channel: "sms",
      subject: "Test",
      body: "Test",
      idempotency_key: "notif:1",
    });
    expect(r1.sent).toBe(false);

    // Second call succeeds
    const r2 = await notifier.send({
      event_id: eventId,
      customer_id: "cust_1",
      merchant_id: TEST_MERCHANT_ID,
      channel: "sms",
      subject: "Test",
      body: "Test",
      idempotency_key: "notif:2",
    });
    expect(r2.sent).toBe(true);
  });

  it("should dispatch events to subscribers via MockEventBus", async () => {
    const received: string[] = [];
    bus.subscribe("order_completed", async (event) => {
      received.push(event.event_id);
    });

    await bus.publish({
      event_id: "evt_1",
      type: "order_completed",
      payload: {},
      occurred_at: new Date(),
    });

    await bus.publish({
      event_id: "evt_2",
      type: "unrelated_event",
      payload: {},
      occurred_at: new Date(),
    });

    expect(received).toEqual(["evt_1"]);
    expect(bus.published).toHaveLength(2);
  });

  it("should track outbox rows and support mark-as-published", async () => {
    const event = await repo.insertEventWithOutbox(
      {
        dedupe_key: "razorpay:pay_outbox_test",
        merchant_id: TEST_MERCHANT_ID,
        source_type: "checkout_abandon",
        customer_id: TEST_CUSTOMER_ID,
        amount: 3000,
        currency: "INR",
        raw_reason: null,
      },
      { type: "test_payload" },
    );
    expect(event).not.toBeNull();

    // Outbox should have one unpublished row
    const unpublished = await repo.findUnpublishedOutbox(10);
    expect(unpublished).toHaveLength(1);
    expect(unpublished[0]!.published).toBe(false);

    // Mark as published
    await repo.markOutboxPublished([unpublished[0]!.id]);

    // No more unpublished
    const afterPublish = await repo.findUnpublishedOutbox(10);
    expect(afterPublish).toHaveLength(0);
  });

  it("should reset mocks cleanly between tests", () => {
    // This test runs after beforeEach — all mocks should be fresh
    expect(repo.events.size).toBe(0);
    expect(gateway.calls).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });
});
