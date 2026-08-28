/**
 * Mock adapter: MockNotificationGateway
 *
 * In-memory fake implementing the NotificationGateway port.
 * Records all sent notifications and supports failure injection.
 */

import { randomUUID } from "node:crypto";
import type {
  NotificationGateway,
  NotificationRequest,
  NotificationResponse,
} from "../../ports/notification_gateway.js";

export class MockNotificationGateway implements NotificationGateway {
  /** Log of all notification requests, for test assertions. */
  readonly sent: NotificationRequest[] = [];

  // ── Failure injection ────────────────────────────────────────────
  private readonly failureMap = new Map<string, number>(); // eventId → remaining failures

  /**
   * Configure the mock to fail the next N send() calls for the given event ID.
   */
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
    this.sent.length = 0;
    this.failureMap.clear();
  }

  // ── Port implementation ──────────────────────────────────────────

  async send(request: NotificationRequest): Promise<NotificationResponse> {
    this.sent.push(request);

    if (this.consumeFailure(request.event_id)) {
      return {
        sent: false,
        provider_ref: null,
        detail: "MockNotificationGateway: injected failure",
      };
    }

    return {
      sent: true,
      provider_ref: `mock_notif_${randomUUID().slice(0, 8)}`,
      detail: null,
    };
  }
}
