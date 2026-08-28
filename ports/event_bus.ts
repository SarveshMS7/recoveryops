/**
 * Port: EventBus
 *
 * Internal event bus for publishing domain events within the system.
 * Implemented by the outbox-based poller (adapters/outbox/) in production,
 * and by an in-memory bus in the mock adapter.
 *
 * This is NOT an external message broker — per AGENTS.md, no Kafka/
 * RabbitMQ/SQS is allowed.  The real adapter polls the Postgres outbox
 * table and "publishes" by calling registered handlers.
 */

// ── Event types ────────────────────────────────────────────────────

export interface DomainEvent {
  readonly event_id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurred_at: Date;
}

export type EventHandler = (event: DomainEvent) => Promise<void>;

// ── Port interface ─────────────────────────────────────────────────

export interface EventBus {
  /**
   * Publish a domain event.  In the real adapter this writes to the
   * outbox; the poller picks it up and calls handlers.
   */
  publish(event: DomainEvent): Promise<void>;

  /**
   * Register a handler that will be called when events of the given
   * type are published.  Multiple handlers per type are allowed.
   */
  subscribe(eventType: string, handler: EventHandler): void;
}
