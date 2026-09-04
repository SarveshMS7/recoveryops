import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PgEventRepository } from "../../adapters/postgres/pg_event_repository.js";
import { MockLlmClient } from "../../adapters/mock/mock_llm_client.js";
import { MockPaymentGateway } from "../../adapters/mock/mock_payment_gateway.js";
import { ingestEvent } from "../../application/ingest_event.js";
import {
  runScoringPass,
  DEFAULT_COEFFICIENTS,
} from "../../application/run_scoring_pass.js";
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

// Policy config
const testPolicyConfig: PolicyConfig = {
  retry_limit: { max_attempts: 3 },
  cooldown: { min_interval_seconds: 0 },  // No cooldown for tests
  spend_cap: { daily_limit_inr: 10_000_000 },
  compliance_window: { start_hour: 0, end_hour: 24 }, // Always open
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
}, 30_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
});

beforeEach(() => {
  llm = new MockLlmClient();
  gateway = new MockPaymentGateway();
});

// ── Helpers ────────────────────────────────────────────────────────

const MERCHANT_ID = "00000000-0000-0000-0000-000000000099";

async function seedAllocatedEvent(suffix: string): Promise<string> {
  const result = await ingestEvent(repo, {
    source: "razorpay",
    external_ref: `chaos_concurrent_${suffix}`,
    merchant_id: MERCHANT_ID,
    source_type: "payment_failure",
    customer_id: `cust_${suffix}`,
    amount: 2000,
    currency: "INR",
    raw_reason: "card_declined",
  });
  expect(result).not.toBeNull();
  const eventId = result!.id;

  // Run scoring with 0% control rate so ALL events go to treatment
  await runScoringPass(repo, DEFAULT_COEFFICIENTS, 0);

  // Run allocation with a huge budget so all events get allocated
  await runAllocationPass(repo, 1_000_000);

  // Verify the event is in Allocated state
  const state = await repo.getCurrentState(eventId);
  expect(state).toBe("Allocated");

  return eventId;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Task 16: Concurrent execution / idempotency", () => {
  it("fires two simultaneous execute_decision calls and asserts exactly one Succeeded row", async () => {
    const eventId = await seedAllocatedEvent("1");
    const event = (await repo.findEventById(eventId))!;

    // Fire two requests concurrently
    const p1 = executeDecision(repo, llm, gateway, testPolicyConfig, event, 1);
    const p2 = executeDecision(repo, llm, gateway, testPolicyConfig, event, 1);

    const [outcome1, outcome2] = await Promise.all([p1, p2]);

    // One should succeed, the other should be idempotent_skip
    const statuses = [outcome1.status, outcome2.status].sort();
    expect(statuses).toEqual(["idempotent_skip", "succeeded"]);

    // Verify there is exactly one Succeeded state in the audit_log
    const auditLogs = await repo.findAuditLogsByEventId(eventId);
    const succeededLogs = auditLogs.filter((log) => log.stage === "Succeeded");
    if (succeededLogs.length !== 1) {
      console.log("AUDIT LOGS:", JSON.stringify(auditLogs, null, 2));
    }
    expect(succeededLogs.length).toBe(1);

    // Verify exactly one action_execution row was inserted
    const executions = await repo.findActionExecutionsByEventId(eventId);
    expect(executions.length).toBe(1);
    expect(executions[0]!.result).toBe("success");
    
    // Check current state is Succeeded
    const finalState = await repo.getCurrentState(eventId);
    if (finalState !== "Succeeded") {
      const logs = await repo.findAuditLogsByEventId(eventId);
      console.log("AUDIT LOGS:", JSON.stringify(logs, null, 2));
    }
    expect(finalState).toBe("Succeeded");
  });
});
