/**
 * Integration test: scoring + allocation pass against real Postgres.
 *
 * Proves:
 *   1. Every seeded event ends up in exactly one of
 *      {Parked_Control, Skipped, Allocated} — no overlaps, no omissions.
 *   2. Control group events are parked (no action taken).
 *   3. Treatment group events are either allocated or skipped.
 *   4. Score rows exist for every event after the scoring pass.
 *   5. State machine transitions are valid.
 *
 * Prerequisites:
 *   docker compose up -d   (Postgres on localhost:5432)
 *   Migrations already applied (test setup handles this).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgEventRepository } from "../../adapters/postgres/pg_event_repository.js";
import { ingestEvent } from "../../application/ingest_event.js";
import {
  runScoringPass,
  DEFAULT_COEFFICIENTS,
} from "../../application/run_scoring_pass.js";
import { runAllocationPass } from "../../application/run_allocation_pass.js";

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

// ── Helpers ────────────────────────────────────────────────────────

const MERCHANT_ID = "00000000-0000-0000-0000-000000000099";

const RAW_REASONS = [
  "card_declined",
  "insufficient_funds",
  "issuer_unavailable",
  "do_not_honor",
  "expired_card",
  "network_error",
  "fraud_suspected",
  "timeout",
  "invalid_card",
  "lost_card",
];

/** Seed N events via the ingest pipeline. */
async function seedEvents(count: number): Promise<string[]> {
  const eventIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const result = await ingestEvent(repo, {
      source: "razorpay",
      external_ref: `scoring_alloc_test_${i}`,
      merchant_id: MERCHANT_ID,
      source_type: i % 4 === 0 ? "checkout_abandon" : "payment_failure",
      customer_id: `cust_test_${i}`,
      amount: 500 + i * 100,
      currency: "INR",
      raw_reason: RAW_REASONS[i % RAW_REASONS.length]!,
    });
    if (result) {
      eventIds.push(result.id);
    }
  }
  return eventIds;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Task 11 — Scoring + allocation pass integration", () => {
  it("should place every event into exactly one of {Parked_Control, Skipped, Allocated}", async () => {
    // ── Seed 20 events ──────────────────────────────────────────
    const eventIds = await seedEvents(20);
    expect(eventIds.length).toBe(20);

    // ── Run scoring pass ────────────────────────────────────────
    const scoringResult = await runScoringPass(repo, DEFAULT_COEFFICIENTS, 0.1);

    expect(scoringResult.scored).toBe(20);
    expect(scoringResult.control + scoringResult.treatment).toBe(20);

    // Verify every event has a score
    for (const id of eventIds) {
      const score = await repo.findScoreByEventId(id);
      expect(score).not.toBeNull();
      expect(score!.p_loss).toBeGreaterThan(0);
      expect(score!.p_uplift).toBeGreaterThan(0);
      expect(score!.expected_value).toBeGreaterThan(0);
      expect(score!.cost_estimate).toBeGreaterThan(0);
    }

    // Verify every event has a group assigned
    for (const id of eventIds) {
      const event = await repo.findEventById(id);
      expect(event).not.toBeNull();
      expect(event!.group).toBeDefined();
      expect(["treatment", "control"]).toContain(event!.group);
    }

    // Verify every event is in Scored state
    for (const id of eventIds) {
      const state = await repo.getCurrentState(id);
      expect(state).toBe("Scored");
    }

    // ── Run allocation pass ─────────────────────────────────────
    // Use a budget that funds some but not all treatment events
    const allocationResult = await runAllocationPass(repo, 500);

    // Total processed should be 20
    expect(allocationResult.total).toBe(20);

    // Control + allocated + skipped = total
    expect(
      allocationResult.parked_control +
        allocationResult.allocated +
        allocationResult.skipped,
    ).toBe(20);

    // Control count should match scoring pass
    expect(allocationResult.parked_control).toBe(scoringResult.control);

    // Allocated + skipped should equal treatment count
    expect(allocationResult.allocated + allocationResult.skipped).toBe(
      scoringResult.treatment,
    );

    // ── Verify no overlaps, no omissions ────────────────────────
    const parkedIds = new Set<string>();
    const allocatedIds = new Set<string>();
    const skippedIds = new Set<string>();

    for (const id of eventIds) {
      const state = await repo.getCurrentState(id);
      expect(state).not.toBeNull();

      if (state === "Parked_Control") {
        parkedIds.add(id);
      } else if (state === "Allocated") {
        allocatedIds.add(id);
      } else if (state === "Skipped") {
        skippedIds.add(id);
      } else {
        // Should never happen — every event must be in one of the three
        expect.unreachable(
          `Event ${id} is in unexpected state: ${state}`,
        );
      }
    }

    // No overlaps
    for (const id of parkedIds) {
      expect(allocatedIds.has(id)).toBe(false);
      expect(skippedIds.has(id)).toBe(false);
    }
    for (const id of allocatedIds) {
      expect(parkedIds.has(id)).toBe(false);
      expect(skippedIds.has(id)).toBe(false);
    }
    for (const id of skippedIds) {
      expect(parkedIds.has(id)).toBe(false);
      expect(allocatedIds.has(id)).toBe(false);
    }

    // No omissions — every event is accounted for
    expect(parkedIds.size + allocatedIds.size + skippedIds.size).toBe(20);

    // Parked events should be control group
    for (const id of parkedIds) {
      const event = await repo.findEventById(id);
      expect(event!.group).toBe("control");
    }

    // Allocated and skipped events should be treatment group
    for (const id of [...allocatedIds, ...skippedIds]) {
      const event = await repo.findEventById(id);
      expect(event!.group).toBe("treatment");
    }

    // Budget should be respected
    expect(allocationResult.total_cost).toBeLessThanOrEqual(500);
    expect(allocationResult.remaining_budget).toBeGreaterThanOrEqual(0);
    expect(allocationResult.total_cost + allocationResult.remaining_budget).toBe(500);
  });

  it("should handle empty batch gracefully", async () => {
    // Scoring pass with no unscored events (all were scored above)
    const scoringResult = await runScoringPass(repo, DEFAULT_COEFFICIENTS, 0.1);
    expect(scoringResult.scored).toBe(0);

    // Allocation pass with no unallocated events
    const allocationResult = await runAllocationPass(repo, 1000);
    expect(allocationResult.total).toBe(0);
    expect(allocationResult.parked_control).toBe(0);
    expect(allocationResult.allocated).toBe(0);
    expect(allocationResult.skipped).toBe(0);
  });
});
