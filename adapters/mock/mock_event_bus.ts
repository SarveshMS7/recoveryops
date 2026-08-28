/**
 * Mock adapter: MockEventBus
 *
 * In-memory fake implementing the EventBus port.
 * Publishes events synchronously to registered handlers.
 * Records all published events for test assertions.
 */

import type {
  EventBus,
  DomainEvent,
  EventHandler,
} from "../../ports/event_bus.js";

export class MockEventBus implements EventBus {
  /** All published events, in order. */
  readonly published: DomainEvent[] = [];

  private readonly handlers = new Map<string, EventHandler[]>();

  // ── Failure injection ────────────────────────────────────────────
  private readonly failureMap = new Map<string, number>(); // eventId → remaining failures

  forceFailureFor(eventId: string, times: number): void {
    this.failureMap.set(eventId, times);
  }

  private consumeFailure(eventId: string): boolean {
    const remaining = this.failureMap.get(eventId);
    if (remaining !== undefined && remaining > 0) {
      this.failureMap.set(eventId, remaining - 1);
      return true;
    }
    return false;
  }

  /** Reset all state. */
  reset(): void {
    this.published.length = 0;
    this.handlers.clear();
    this.failureMap.clear();
  }

  // ── Port implementation ──────────────────────────────────────────

  async publish(event: DomainEvent): Promise<void> {
    if (this.consumeFailure(event.event_id)) {
      throw new Error("MockEventBus: injected failure");
    }

    this.published.push(event);

    // Dispatch to registered handlers synchronously
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
}
