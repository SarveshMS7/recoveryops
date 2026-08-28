/**
 * Mock adapter: MockPaymentGateway
 *
 * In-memory fake implementing the PaymentGateway port.
 * Returns success by default. Supports configurable failure injection.
 */

import { randomUUID } from "node:crypto";
import type {
  PaymentGateway,
  PaymentActionRequest,
  PaymentActionResponse,
} from "../../ports/payment_gateway.js";

export class MockPaymentGateway implements PaymentGateway {
  /** Log of all calls made, for test assertions. */
  readonly calls: PaymentActionRequest[] = [];

  // ── Failure injection ────────────────────────────────────────────
  private readonly failureMap = new Map<string, number>(); // eventId → remaining failures

  /**
   * Configure the mock to return a "failed" result for the next N calls
   * involving the given event ID.
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

  /** Reset all state (calls log + failure injections). */
  reset(): void {
    this.calls.length = 0;
    this.failureMap.clear();
  }

  // ── Port implementation ──────────────────────────────────────────

  async executeAction(
    request: PaymentActionRequest,
  ): Promise<PaymentActionResponse> {
    this.calls.push(request);

    if (this.consumeFailure(request.event_id)) {
      return {
        result: "failed",
        gateway_ref: null,
        detail: "MockPaymentGateway: injected failure",
      };
    }

    return {
      result: "success",
      gateway_ref: `mock_ref_${randomUUID().slice(0, 8)}`,
      detail: null,
    };
  }
}
