import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PgEventRepository } from "../../adapters/postgres/pg_event_repository.js";
import { MockLlmClient } from "../../adapters/mock/mock_llm_client.js";
import { MockPaymentGateway } from "../../adapters/mock/mock_payment_gateway.js";
import { ingestEvent, type RawInboundEvent } from "../../application/ingest_event.js";
import { runScoringPass, DEFAULT_COEFFICIENTS } from "../../application/run_scoring_pass.js";
import { runAllocationPass } from "../../application/run_allocation_pass.js";
import { executeDecision } from "../../application/execute_decision.js";
import type { PolicyConfig } from "../../domain/policy.js";

const { Pool } = pg;

// ── Test setup ─────────────────────────────────────────────────────

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
let llm: MockLlmClient;
let gateway: MockPaymentGateway;

// Policy config for testing
const testPolicyConfig: PolicyConfig = {
  retry_limit: { max_attempts: 3 },
  cooldown: { min_interval_seconds: 0 },
  spend_cap: { daily_limit_inr: 10_000_000 },
  compliance_window: { start_hour: 0, end_hour: 24 },
};

async function runMigration(filename: string): Promise<void> {
  const sql = readFileSync(
    resolve(process.cwd(), "migrations", filename),
    "utf-8",
  );
  await adminPool.query(sql);
}

beforeAll(async () => {
  adminPool = new Pool(ADMIN_POOL_CONFIG);

  // Clean slate
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
  llm = new MockLlmClient();
  gateway = new MockPaymentGateway();
}, 30_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
});

// ── Stripe Synthetic Feed Normalizer ───────────────────────────────

interface StripeInvoiceFailedEvent {
  type: string;
  data: {
    object: {
      id: string;
      customer: string;
      amount_due: number;
      currency: string;
      billing_reason: string;
      last_payment_error?: {
        code: string;
      };
    };
  };
}

function normalizeStripeSubscriptionEvent(
  merchantId: string,
  stripeEvent: StripeInvoiceFailedEvent
): RawInboundEvent | null {
  if (stripeEvent.type !== "invoice.payment_failed") {
    return null;
  }

  const invoice = stripeEvent.data.object;
  // Convert cents to standard units assuming INR for test
  const amount = invoice.amount_due / 100;
  
  let rawReason = "unknown";
  if (invoice.last_payment_error?.code) {
    rawReason = invoice.last_payment_error.code;
  }

  return {
    source: "stripe_billing",
    external_ref: invoice.id,
    merchant_id: merchantId,
    source_type: "subscription",
    customer_id: invoice.customer,
    amount: amount,
    currency: invoice.currency.toUpperCase(),
    raw_reason: rawReason,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Task 19: Second detector: failed-subscription", () => {
  it("flows a synthetic Stripe subscription feed through the entire pipeline unmodified", async () => {
    const merchantId = "00000000-0000-0000-0000-000000000099";

    // 1. Synthetic feed event (Stripe invoice.payment_failed)
    const stripeEvent: StripeInvoiceFailedEvent = {
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_1N2b3c4d5e6f",
          customer: "cus_H8Y9Z0",
          amount_due: 49900, // 499.00 INR
          currency: "inr",
          billing_reason: "subscription_cycle",
          last_payment_error: {
            code: "insufficient_funds" // retryable
          }
        }
      }
    };

    // 2. Normalizer mapping
    const rawInbound = normalizeStripeSubscriptionEvent(merchantId, stripeEvent);
    expect(rawInbound).not.toBeNull();
    
    // 3. Ingest
    const ingestedEvent = await ingestEvent(repo, rawInbound!);
    expect(ingestedEvent).not.toBeNull();
    const eventId = ingestedEvent!.id;
    
    expect(ingestedEvent!.source_type).toBe("subscription");
    
    // 4. Score
    // We use a high threshold and 0% control rate so it gets Treatment
    await runScoringPass(repo, DEFAULT_COEFFICIENTS, 0);
    
    const score = await repo.findScoreByEventId(eventId);
    expect(score).not.toBeNull();
    // It should successfully score despite source_type being "subscription"
    
    // 5. Allocate
    // Run allocation with enough budget
    await runAllocationPass(repo, 100_000);
    
    const state = await repo.getCurrentState(eventId);
    expect(state).toBe("Allocated");
    
    // 6. Execute Decision (LLM + Gateway)
    const eventToExecute = (await repo.findEventById(eventId))!;
    const executionOutcome = await executeDecision(
      repo,
      llm,
      gateway,
      testPolicyConfig,
      eventToExecute,
      1
    );
    
    expect(executionOutcome.status).toBe("succeeded");
    
    // Verify final state
    const finalState = await repo.getCurrentState(eventId);
    expect(finalState).toBe("Succeeded");
  });
});
