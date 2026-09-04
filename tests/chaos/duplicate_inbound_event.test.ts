import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PgEventRepository } from "../../adapters/postgres/pg_event_repository.js";
import { ingestEvent } from "../../application/ingest_event.js";

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

// ── Tests ──────────────────────────────────────────────────────────

describe("Task 17: Duplicate inbound event", () => {
  it("fires the same payload twice and asserts exactly one risk_event row exists", async () => {
    const rawPayload = {
      source: "razorpay",
      external_ref: "pay_duplicate_test_123",
      merchant_id: "00000000-0000-0000-0000-000000000099",
      source_type: "payment_failure" as const,
      customer_id: "cust_dup",
      amount: 5000,
      currency: "INR",
      raw_reason: "insufficient_funds",
    };

    // First ingestion should succeed
    const firstResult = await ingestEvent(repo, rawPayload);
    expect(firstResult).not.toBeNull();
    const eventId = firstResult!.id;

    // Verify it exists in db
    const event = await repo.findEventById(eventId);
    expect(event).not.toBeNull();
    
    // Attempt concurrent duplicate ingestions
    const p1 = ingestEvent(repo, rawPayload);
    const p2 = ingestEvent(repo, rawPayload);
    
    const [dup1, dup2] = await Promise.all([p1, p2]);

    // Both should return null indicating they were duplicates
    expect(dup1).toBeNull();
    expect(dup2).toBeNull();

    // The db should only have exactly ONE row for this event
    const dedupeKey = `razorpay:pay_duplicate_test_123`;
    const foundEvent = await repo.findEventByDedupeKey(dedupeKey);
    expect(foundEvent).not.toBeNull();
    
    // We can also verify total number of events in DB
    const unscoredEvents = await repo.findUnscoredEvents();
    const eventsMatchingRef = unscoredEvents.filter(e => e.dedupe_key === dedupeKey);
    expect(eventsMatchingRef.length).toBe(1);
    
    // Outbox should also only have one row
    const client = await appPool.connect();
    try {
      const outboxRes = await client.query("SELECT id FROM outbox WHERE event_id = $1", [eventId]);
      expect(outboxRes.rows.length).toBe(1);
    } finally {
      client.release();
    }
  });
});
