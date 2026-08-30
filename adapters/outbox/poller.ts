/**
 * Outbox Poller — adapters/outbox/poller.ts
 *
 * Real implementation of the EventBus port using the Postgres outbox
 * pattern (ARCHITECTURE.md §System Diagram, line "Outbox Poller").
 *
 * How it works:
 *   1. `publish()` is a no-op pass-through: the outbox row is already
 *      written atomically with the risk_event by `insertEventWithOutbox`.
 *      Direct calls to `publish()` dispatch to handlers immediately
 *      (useful for in-process eventing without the outbox table).
 *
 *   2. `pollAndPublish()` fetches unpublished outbox rows (oldest first),
 *      dispatches each to registered handlers, and marks each row published
 *      **individually** after dispatch succeeds.  This means a crash
 *      mid-batch does NOT re-publish already-sent rows — only the
 *      remaining unsent rows are retried on the next poll.
 *
 *   3. `start()` / `stop()` run the poll loop on a configurable interval.
 *
 * Per AGENTS.md: no Kafka/RabbitMQ/SQS — Postgres-as-queue only.
 */

import type {
  EventBus,
  DomainEvent,
  EventHandler,
} from "../../ports/event_bus.js";
import type { EventRepository } from "../../ports/event_repository.js";

// ── Configuration ──────────────────────────────────────────────────

export interface OutboxPollerConfig {
  /** Milliseconds between poll cycles.  Default: 1000 */
  readonly pollIntervalMs?: number;
  /** Maximum rows to fetch per poll cycle.  Default: 100 */
  readonly batchSize?: number;
}

// ── Poller ──────────────────────────────────────────────────────────

export class OutboxPoller implements EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly repo: EventRepository,
    config?: OutboxPollerConfig,
  ) {
    this.pollIntervalMs = config?.pollIntervalMs ?? 1000;
    this.batchSize = config?.batchSize ?? 100;
  }

  // ── EventBus interface ──────────────────────────────────────────

  /**
   * Direct publish — dispatches to handlers immediately.
   * The outbox row itself is written by the repository's
   * `insertEventWithOutbox`; this method is for in-process
   * event dispatch without the polling loop.
   */
  async publish(event: DomainEvent): Promise<void> {
    const typeHandlers = this.handlers.get(event.type) ?? [];
    for (const handler of typeHandlers) {
      await handler(event);
    }
  }

  subscribe(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  // ── Polling lifecycle ───────────────────────────────────────────

  /** Start the poll loop (non-blocking). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /** Stop the poll loop gracefully. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Whether the poller is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  // ── Core poll-and-dispatch ──────────────────────────────────────

  /**
   * One poll cycle: fetch unpublished outbox rows, dispatch to
   * handlers, mark each row published **one at a time** so a crash
   * mid-batch leaves no row falsely marked as published.
   *
   * Returns the number of rows successfully published in this cycle.
   */
  async pollAndPublish(): Promise<number> {
    const rows = await this.repo.findUnpublishedOutbox(this.batchSize);
    if (rows.length === 0) return 0;

    let published = 0;

    for (const row of rows) {
      // Reconstruct the DomainEvent from the outbox payload
      const payload = row.payload as Record<string, unknown> | null;
      const event: DomainEvent = {
        event_id: row.event_id,
        type: (payload?.["type"] as string) ?? "unknown",
        payload: payload,
        occurred_at: row.created_at,
      };

      // Dispatch to all handlers for this event type
      const typeHandlers = this.handlers.get(event.type) ?? [];
      for (const handler of typeHandlers) {
        await handler(event);
      }

      // Mark this individual row as published AFTER successful dispatch.
      // If we crash before this line, the row stays unpublished and will
      // be re-dispatched on the next poll — at-least-once delivery.
      await this.repo.markOutboxPublished([row.id]);
      published++;
    }

    return published;
  }

  // ── Internal ────────────────────────────────────────────────────

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.pollAndPublish();
      } catch (_err) {
        // Log and continue — don't crash the loop on transient errors.
        // In production this would go to structured logging.
      }
      this.scheduleNext();
    }, this.pollIntervalMs);
  }
}
