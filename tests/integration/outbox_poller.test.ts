/**
 * Integration test: OutboxPoller against real Postgres.
 *
 * Proves:
 *   1. The poller publishes all unpublished outbox rows to handlers.
 *   2. A poller crash mid-batch, restarted, does NOT re-publish
 *      already-sent rows and DOES eventually publish the rest.
 *   3. An empty outbox produces zero dispatches.
 *   4. Only handlers subscribed to the correct event type receive events.
 *
 * Prerequisites:
 *   docker compose up -d   (Postgres on localhost:5432)
 *   Migrations already applied (test setup handles this).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgEventRepository } from "../../adapters/postgres/pg_event_repository.js";
import { OutboxPoller } from "../../adapters/outbox/poller.js";
import type { EventRepository } from "../../ports/event_repository.js";
import type { DomainEvent } from "../../ports/event_bus.js";

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

/** Truncate all test data between tests. */
async function truncateAll(): Promise<void> {
  await adminPool.query(`
    TRUNCATE TABLE audit_log, outbox, action_execution, policy_check,
                   decision, score, risk_event CASCADE;
  `);
}

/** Seed N risk_events with corresponding outbox rows (unpublished). */
async function seedEvents(
  count: number,
  prefix: string = "poller_test",
): Promise<string[]> {
  const eventIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const result = await repo.insertEventWithOutbox(
      {
        dedupe_key: `${prefix}:evt_${i}`,
        merchant_id: "00000000-0000-0000-0000-000000000099",
        source_type: "payment_failure",
        customer_id: `cust_${i}`,
        amount: 1000 + i,
        currency: "INR",
        raw_reason: "card_declined",
      },
      {
        type: "event_ingested",
        dedupe_key: `${prefix}:evt_${i}`,
        source_type: "payment_failure",
        merchant_id: "00000000-0000-0000-0000-000000000099",
        amount: 1000 + i,
        currency: "INR",
      },
    );
    if (result) {
      eventIds.push(result.id);
    }
  }
  return eventIds;
}

/** Count unpublished outbox rows. */
async function countUnpublished(): Promise<number> {
  const r = await adminPool.query(
    "SELECT COUNT(*)::int AS cnt FROM outbox WHERE published = false",
  );
  return (r.rows[0] as { cnt: number }).cnt;
}

/** Count published outbox rows. */
async function countPublished(): Promise<number> {
  const r = await adminPool.query(
    "SELECT COUNT(*)::int AS cnt FROM outbox WHERE published = true",
  );
  return (r.rows[0] as { cnt: number }).cnt;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Task 10 — OutboxPoller integration against real Postgres", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("should publish all unpublished outbox rows to handlers", async () => {
    // Seed 5 events → 5 unpublished outbox rows
    await seedEvents(5, "publish_all");

    expect(await countUnpublished()).toBe(5);
    expect(await countPublished()).toBe(0);

    // Create poller and subscribe a handler
    const received: DomainEvent[] = [];
    const poller = new OutboxPoller(repo, { batchSize: 100 });
    poller.subscribe("event_ingested", async (event) => {
      received.push(event);
    });

    // Single poll cycle
    const publishedCount = await poller.pollAndPublish();

    expect(publishedCount).toBe(5);
    expect(received.length).toBe(5);
    expect(await countUnpublished()).toBe(0);
    expect(await countPublished()).toBe(5);
  });

  it("should not re-publish already-sent rows after a crash mid-batch, and publish the rest on restart", async () => {
    // Seed 5 events → 5 unpublished outbox rows
    const eventIds = await seedEvents(5, "crash_mid_batch");

    expect(await countUnpublished()).toBe(5);

    // ── First poller instance (simulated crash mid-batch) ──────────
    //
    // Strategy: we create a "sabotaged" repository wrapper that throws
    // after marking the first 2 rows as published but before completing
    // the batch.  This simulates a crash mid-batch.

    const dispatchedBeforeCrash: string[] = [];
    let dispatchCount = 0;

    const crashAfterN = 2; // Crash after processing 2 rows

    const crashingPoller = new OutboxPoller(repo, { batchSize: 100 });
    crashingPoller.subscribe("event_ingested", async (event) => {
      dispatchCount++;
      dispatchedBeforeCrash.push(event.event_id);
      if (dispatchCount >= crashAfterN) {
        // Simulate a crash by throwing after the handler runs for the
        // Nth event.  The poller's pollAndPublish marks each row as
        // published AFTER dispatch, so the Nth row will have been
        // dispatched but then we throw — but crucially, the earlier
        // rows were already individually marked as published.
        //
        // Wait: the poller marks AFTER handler.  So let's let the
        // marking happen for the 2nd one, then crash before the 3rd
        // dispatch.  We achieve this by throwing on the 3rd dispatch.
      }
      if (dispatchCount > crashAfterN) {
        throw new Error("Simulated crash mid-batch");
      }
    });

    // Run pollAndPublish — it will crash partway through because the
    // handler throws on the 3rd event.
    try {
      await crashingPoller.pollAndPublish();
    } catch {
      // Expected — the simulated crash
    }

    // After the crash: the first 2 rows should be published (handler
    // ran and markOutboxPublished succeeded for each).
    // The 3rd row had the handler throw, so markOutboxPublished was
    // never called → it stays unpublished.
    // The 4th and 5th rows were never even attempted.
    const publishedAfterCrash = await countPublished();
    const unpublishedAfterCrash = await countUnpublished();

    // At least 2 should be published, at most 3 (the one where handler
    // threw might or might not have been marked depending on throw timing)
    expect(publishedAfterCrash).toBeGreaterThanOrEqual(2);
    expect(unpublishedAfterCrash).toBeGreaterThanOrEqual(2);
    expect(publishedAfterCrash + unpublishedAfterCrash).toBe(5);

    // ── Second poller instance (restart after crash) ───────────────

    const dispatchedAfterRestart: string[] = [];
    const restartedPoller = new OutboxPoller(repo, { batchSize: 100 });
    restartedPoller.subscribe("event_ingested", async (event) => {
      dispatchedAfterRestart.push(event.event_id);
    });

    const restartPublished = await restartedPoller.pollAndPublish();

    // The restarted poller should pick up ONLY the unpublished rows
    expect(restartPublished).toBe(unpublishedAfterCrash);
    expect(dispatchedAfterRestart.length).toBe(unpublishedAfterCrash);

    // Now ALL 5 should be published
    expect(await countPublished()).toBe(5);
    expect(await countUnpublished()).toBe(0);

    // Crucially: the already-published rows should NOT have been
    // re-dispatched.  The events dispatched after restart must NOT
    // include any events that were already dispatched before the crash.
    //
    // The first `crashAfterN` events were dispatched before the crash.
    // None of those event_ids should appear in the after-restart list.
    const beforeCrashSet = new Set(dispatchedBeforeCrash.slice(0, crashAfterN));
    for (const id of dispatchedAfterRestart) {
      expect(beforeCrashSet.has(id)).toBe(false);
    }
  });

  it("should handle an empty outbox with zero dispatches", async () => {
    // No events seeded
    expect(await countUnpublished()).toBe(0);

    const received: DomainEvent[] = [];
    const poller = new OutboxPoller(repo, { batchSize: 100 });
    poller.subscribe("event_ingested", async (event) => {
      received.push(event);
    });

    const count = await poller.pollAndPublish();
    expect(count).toBe(0);
    expect(received.length).toBe(0);
  });

  it("should only dispatch to handlers subscribed to the matching event type", async () => {
    await seedEvents(3, "type_filter");

    const ingestedEvents: DomainEvent[] = [];
    const otherEvents: DomainEvent[] = [];

    const poller = new OutboxPoller(repo, { batchSize: 100 });
    poller.subscribe("event_ingested", async (event) => {
      ingestedEvents.push(event);
    });
    poller.subscribe("some_other_type", async (event) => {
      otherEvents.push(event);
    });

    await poller.pollAndPublish();

    // All 3 events have type "event_ingested" → only that handler fires
    expect(ingestedEvents.length).toBe(3);
    expect(otherEvents.length).toBe(0);
  });
});
