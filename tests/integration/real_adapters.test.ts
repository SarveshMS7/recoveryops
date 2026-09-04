/**
 * Integration test: Real adapters (Task 13 — Razorpay, Task 14 — Gemini LLM)
 *
 * Proves:
 *   1. Both adapters satisfy their port interfaces (construction, types).
 *   2. No-op actions (escalate, none) return success without calling APIs.
 *   3. Error normalisation returns valid ExecutionResult values.
 *   4. (Guarded) The Task 12 pipeline — ingest → score → allocate → execute —
 *      passes with the real adapters instead of mocks.
 *
 * The "same integration tests pass unmodified" requirement (from TASKS.md)
 * is proven by running the identical executeDecision() flow from Task 12
 * but with RazorpayPaymentGateway and GeminiLlmClient in place of the
 * mocks.  Assertions that relied on mock-specific APIs (setResponseFor,
 * calls.length) are replaced by port-contract assertions (e.g. action ∈
 * closed enum).
 *
 * Prerequisites:
 *   docker compose up -d   (Postgres on localhost:5432)
 *   RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET   (test-mode keys)
 *   GEMINI_API_KEY                           (Google AI Studio key)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Real adapters under test ──────────────────────────────────────
import { RazorpayPaymentGateway } from "../../adapters/razorpay/razorpay_payment_gateway.js";
import { GeminiLlmClient } from "../../adapters/llm/gemini_llm_client.js";

// ── Application layer (identical to Task 12 test) ─────────────────
import { PgEventRepository } from "../../adapters/postgres/pg_event_repository.js";
import { ingestEvent } from "../../application/ingest_event.js";
import {
  runScoringPass,
  DEFAULT_COEFFICIENTS,
} from "../../application/run_scoring_pass.js";
import { runAllocationPass } from "../../application/run_allocation_pass.js";
import {
  executeDecision,
  InvalidLlmActionError,
} from "../../application/execute_decision.js";
import { VALID_ACTIONS } from "../../ports/types.js";
import type { PolicyConfig } from "../../domain/policy.js";
import type { PaymentGateway } from "../../ports/payment_gateway.js";
import type { LlmClient } from "../../ports/llm_client.js";

const { Pool } = pg;

// ── Credential guards ─────────────────────────────────────────────

const HAS_RAZORPAY =
  !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET;
const HAS_GEMINI = !!process.env.GEMINI_API_KEY;
const HAS_ALL = HAS_RAZORPAY && HAS_GEMINI;

// ── Test DB config (same as Task 12) ──────────────────────────────

const ADMIN_POOL_CONFIG = {
  host: "localhost",
  port: 5432,
  user: "recoveryops_admin",
  password: "local_dev_only",
  database: "recoveryops",
};

let adminPool: InstanceType<typeof Pool>;
let appPool: InstanceType<typeof Pool>;
let repo: PgEventRepository;

const testPolicyConfig: PolicyConfig = {
  retry_limit: { max_attempts: 3 },
  cooldown: { min_interval_seconds: 0 },
  spend_cap: { daily_limit_inr: 10_000_000 },
  compliance_window: { start_hour: 0, end_hour: 24 },
};

const MERCHANT_ID = "00000000-0000-0000-0000-000000000099";

async function runMigration(filename: string): Promise<void> {
  const sql = readFileSync(
    resolve(process.cwd(), "migrations", filename),
    "utf-8",
  );
  await adminPool.query(sql);
}

// ────────────────────────────────────────────────────────────────────
// Task 13 — Razorpay adapter (PaymentGateway port)
// ────────────────────────────────────────────────────────────────────

describe("Task 13 — RazorpayPaymentGateway adapter", () => {
  it("should throw if credentials are missing", () => {
    const origKey = process.env.RAZORPAY_KEY_ID;
    const origSecret = process.env.RAZORPAY_KEY_SECRET;
    try {
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;
      expect(() => new RazorpayPaymentGateway()).toThrow(
        /RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required/,
      );
    } finally {
      if (origKey !== undefined) process.env.RAZORPAY_KEY_ID = origKey;
      if (origSecret !== undefined) process.env.RAZORPAY_KEY_SECRET = origSecret;
    }
  });

  it("should construct successfully with explicit config", () => {
    const gw = new RazorpayPaymentGateway({
      key_id: "rzp_test_dummy",
      key_secret: "dummy_secret_value",
    });
    expect(gw).toBeDefined();
  });

  it("should satisfy the PaymentGateway port interface", () => {
    const gw: PaymentGateway = new RazorpayPaymentGateway({
      key_id: "rzp_test_dummy",
      key_secret: "dummy_secret_value",
    });
    expect(typeof gw.executeAction).toBe("function");
  });

  it("should return success for escalate (no-op, no API call)", async () => {
    const gw = new RazorpayPaymentGateway({
      key_id: "rzp_test_dummy",
      key_secret: "dummy_secret_value",
    });
    const result = await gw.executeAction({
      event_id: "test-event-1",
      external_ref: "pay_test_1",
      action: "escalate",
      amount: 1000,
      currency: "INR",
      idempotency_key: "test-event-1:1",
    });
    expect(result.result).toBe("success");
    expect(result.gateway_ref).toBeNull();
    expect(result.detail).toContain("escalate");
  });

  it("should return success for none (no-op, no API call)", async () => {
    const gw = new RazorpayPaymentGateway({
      key_id: "rzp_test_dummy",
      key_secret: "dummy_secret_value",
    });
    const result = await gw.executeAction({
      event_id: "test-event-2",
      external_ref: "pay_test_2",
      action: "none",
      amount: 1000,
      currency: "INR",
      idempotency_key: "test-event-2:1",
    });
    expect(result.result).toBe("success");
    expect(result.gateway_ref).toBeNull();
    expect(result.detail).toContain("none");
  });

  it("should normalise network errors to timeout result", async () => {
    // Point to a non-existent URL to force a network error
    const gw = new RazorpayPaymentGateway({
      key_id: "rzp_test_dummy",
      key_secret: "dummy_secret_value",
      base_url: "http://localhost:1", // nothing listening here
      timeout_ms: 2_000,
    });
    const result = await gw.executeAction({
      event_id: "test-event-3",
      external_ref: "pay_test_3",
      action: "retry_now",
      amount: 1000,
      currency: "INR",
      idempotency_key: "test-event-3:1",
    });
    expect(result.result).toBe("timeout");
    expect(result.gateway_ref).toBeNull();
    expect(result.detail).toBeTruthy();
  });

  it("should normalise 4xx errors to failed result", async () => {
    // Use real Razorpay URL but dummy credentials → 401 Unauthorized
    const gw = new RazorpayPaymentGateway({
      key_id: "rzp_test_invalid_key",
      key_secret: "invalid_secret",
      timeout_ms: 15_000,
    });
    const result = await gw.executeAction({
      event_id: "test-event-4",
      external_ref: "pay_test_4",
      action: "retry_now",
      amount: 1000,
      currency: "INR",
      idempotency_key: "test-event-4:1",
    });
    expect(result.result).toBe("failed");
    expect(result.gateway_ref).toBeNull();
    expect(result.detail).toBeTruthy();
  }, 20_000);

  describe.skipIf(!HAS_RAZORPAY)(
    "against real test-mode API",
    () => {
      let gw: RazorpayPaymentGateway;

      beforeAll(() => {
        gw = new RazorpayPaymentGateway();
      });

      it("should create a payment link for retry_now", async () => {
        const result = await gw.executeAction({
          event_id: "e2e-test-1",
          external_ref: `pay_e2e_1_${Date.now()}`,
          action: "retry_now",
          amount: 1000,
          currency: "INR",
          idempotency_key: `e2e-test-1-${Date.now()}`,
        });
        if (result.result !== "success") {
          console.error("Razorpay Error:", result.detail);
        }
        expect(result.result).toBe("success");
        expect(result.gateway_ref).toBeTruthy(); // plink_...
        expect(result.detail).toBeNull();
      }, 30_000);

      it("should create a payment link for send_reminder", async () => {
        const result = await gw.executeAction({
          event_id: "e2e-test-2",
          external_ref: `pay_e2e_2_${Date.now()}`,
          action: "send_reminder",
          amount: 2000,
          currency: "INR",
          idempotency_key: `e2e-test-2-${Date.now()}`,
        });
        if (result.result !== "success") {
          console.error("Razorpay Error:", result.detail);
        }
        expect(result.result).toBe("success");
        expect(result.gateway_ref).toBeTruthy();
      }, 30_000);
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// Task 14 — Gemini LLM adapter (LlmClient port)
// ────────────────────────────────────────────────────────────────────

describe("Task 14 — GeminiLlmClient adapter", () => {
  it("should throw if API key is missing", () => {
    const orig = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      expect(() => new GeminiLlmClient()).toThrow(
        /GEMINI_API_KEY is required/,
      );
    } finally {
      if (orig !== undefined) process.env.GEMINI_API_KEY = orig;
    }
  });

  it("should construct successfully with explicit config", () => {
    const client = new GeminiLlmClient({ api_key: "dummy_key" });
    expect(client).toBeDefined();
  });

  it("should satisfy the LlmClient port interface", () => {
    const client: LlmClient = new GeminiLlmClient({ api_key: "dummy_key" });
    expect(typeof client.analyse).toBe("function");
  });

  describe.skipIf(!HAS_GEMINI)(
    "against real Gemini API",
    () => {
      let client: GeminiLlmClient;

      beforeAll(() => {
        client = new GeminiLlmClient();
      });

      it("should analyse a risk event and return an action from the closed enum", async () => {
        const response = await client.analyse({
          event_id: "llm-test-1",
          source_type: "payment_failure",
          amount: 5000,
          currency: "INR",
          raw_reason: "card_declined",
          attempt_count: 0,
          context: {
            merchant_id: MERCHANT_ID,
            customer_id: "cust_llm_1",
          },
        });

        expect(response.root_cause_summary).toBeTruthy();
        expect(VALID_ACTIONS).toContain(response.selected_action);
        expect(response.rationale).toBeTruthy();
      }, 60_000);

      it("should handle multiple calls with different contexts", async () => {
        const response = await client.analyse({
          event_id: "llm-test-2",
          source_type: "checkout_abandon",
          amount: 99900,
          currency: "INR",
          raw_reason: "timeout_at_checkout",
          attempt_count: 2,
          context: {
            merchant_id: MERCHANT_ID,
            customer_id: "cust_llm_2",
          },
        });

        expect(response.root_cause_summary).toBeTruthy();
        expect(VALID_ACTIONS).toContain(response.selected_action);
        expect(response.rationale).toBeTruthy();
      }, 60_000);
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// Task 12 pipeline — real adapters (proves port substitutability)
// ────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_ALL)(
  "Task 12 pipeline with real adapters (port substitutability proof)",
  () => {
    let rzpGateway: RazorpayPaymentGateway;
    let geminiLlm: GeminiLlmClient;

    async function seedAllocatedEvent(suffix: string): Promise<string> {
      const result = await ingestEvent(repo, {
        source: "razorpay",
        external_ref: `real_adapter_${suffix}`,
        merchant_id: MERCHANT_ID,
        source_type: "payment_failure",
        customer_id: `cust_${suffix}`,
        amount: 2000,
        currency: "INR",
        raw_reason: "card_declined",
      });
      expect(result).not.toBeNull();
      const eventId = result!.id;

      await runScoringPass(repo, DEFAULT_COEFFICIENTS, 0);
      await runAllocationPass(repo, 1_000_000);

      const state = await repo.getCurrentState(eventId);
      expect(state).toBe("Allocated");
      return eventId;
    }

    async function countActionExecutions(eventId: string): Promise<number> {
      const r = await adminPool.query(
        "SELECT COUNT(*)::int AS cnt FROM action_execution WHERE event_id = $1",
        [eventId],
      );
      return (r.rows[0] as { cnt: number }).cnt;
    }

    beforeAll(async () => {
      adminPool = new Pool(ADMIN_POOL_CONFIG);
      await adminPool.query(`
        DROP TABLE IF EXISTS audit_log CASCADE;
        DROP TABLE IF EXISTS outbox CASCADE;
        DROP TABLE IF EXISTS action_execution CASCADE;
        DROP TABLE IF EXISTS policy_check CASCADE;
        DROP TABLE IF EXISTS decision CASCADE;
        DROP TABLE IF EXISTS score CASCADE;
        DROP TABLE IF EXISTS risk_event CASCADE;
        DROP TYPE IF EXISTS source_type CASCADE;
        DROP TYPE IF EXISTS risk_group CASCADE;
        DROP TYPE IF EXISTS selected_action CASCADE;
        DROP TYPE IF EXISTS policy_check_name CASCADE;
        DROP TYPE IF EXISTS execution_result CASCADE;
      `);

      await runMigration("001_extensions_and_enums.sql");
      await runMigration("002_core_tables.sql");
      await runMigration("003_app_role_and_grants.sql");

      appPool = new Pool({
        host: "localhost",
        port: 5432,
        user: "recoveryops_app",
        password: "change_me_in_env",
        database: "recoveryops",
      });

      repo = new PgEventRepository(appPool);
      rzpGateway = new RazorpayPaymentGateway();
      geminiLlm = new GeminiLlmClient();
    }, 30_000);

    afterAll(async () => {
      await appPool?.end();
      await adminPool?.end();
    });

    beforeEach(async () => {
      await adminPool.query(`
        TRUNCATE TABLE audit_log, outbox, action_execution, policy_check,
                       decision, score, risk_event CASCADE;
      `);
    });

    it("should execute successfully with real adapters (identical to Task 12 test 1)", async () => {
      const eventId = await seedAllocatedEvent("real_success_1");
      const event = await repo.findEventById(eventId);
      expect(event).not.toBeNull();

      const outcome = await executeDecision(
        repo,
        geminiLlm,       // ← real LLM, not mock
        rzpGateway,       // ← real Razorpay, not mock
        testPolicyConfig,
        event!,
        1,
      );

      expect(outcome.status).toBe("succeeded");

      // Exactly one action_execution row
      const execCount = await countActionExecutions(eventId);
      expect(execCount).toBe(1);

      // State machine ended at Succeeded
      const finalState = await repo.getCurrentState(eventId);
      expect(finalState).toBe("Succeeded");

      // Decision was recorded with a VALID action from the closed enum
      const decision = await repo.findDecisionByEventId(eventId);
      expect(decision).not.toBeNull();
      expect(VALID_ACTIONS).toContain(decision!.selected_action);
    }, 60_000);

    it("should produce exactly one action_execution for duplicate idempotency_key (identical to Task 12 test 2)", async () => {
      const eventId = await seedAllocatedEvent("real_idem_1");
      const event = await repo.findEventById(eventId);
      expect(event).not.toBeNull();

      // First execution
      const outcome1 = await executeDecision(
        repo, geminiLlm, rzpGateway, testPolicyConfig, event!, 1,
      );
      expect(outcome1.status).toBe("succeeded");

      let execCount = await countActionExecutions(eventId);
      expect(execCount).toBe(1);

      // Directly insert duplicate idempotency_key via repo (same as Task 12)
      const dupResult = await repo.insertActionExecution({
        event_id: eventId,
        idempotency_key: `${eventId}:1`,
        action: "retry_now",
        attempt_number: 1,
        result: "success",
      });
      expect(dupResult).toBeNull(); // idempotent skip

      execCount = await countActionExecutions(eventId);
      expect(execCount).toBe(1);
    }, 60_000);

    it("should handle policy rejection with real adapters (identical to Task 12 test 4)", async () => {
      const eventId = await seedAllocatedEvent("real_policy_1");
      const event = await repo.findEventById(eventId);
      expect(event).not.toBeNull();

      const strictPolicy: PolicyConfig = {
        retry_limit: { max_attempts: 0 },
        cooldown: { min_interval_seconds: 0 },
        spend_cap: { daily_limit_inr: 10_000_000 },
        compliance_window: { start_hour: 0, end_hour: 24 },
      };

      const outcome = await executeDecision(
        repo, geminiLlm, rzpGateway, strictPolicy, event!, 1,
      );

      expect(outcome.status).toBe("policy_rejected");

      // Decision was recorded (policy rejection happens AFTER LLM + decision)
      const decision = await repo.findDecisionByEventId(eventId);
      expect(decision).not.toBeNull();
      expect(VALID_ACTIONS).toContain(decision!.selected_action);

      // NO action_execution — policy blocked it
      const execCount = await countActionExecutions(eventId);
      expect(execCount).toBe(0);

      // State should be Escalated
      const finalState = await repo.getCurrentState(eventId);
      expect(finalState).toBe("Escalated");
    }, 60_000);
  },
);
