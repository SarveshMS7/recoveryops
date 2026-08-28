/**
 * Port: NotificationGateway
 *
 * Sends customer-facing notifications (email, SMS, push) as part of
 * recovery actions like `send_reminder` or `offer_alt_method`.
 * Adapters: adapters/mock/ (in-memory fake).
 *
 * The gateway does not decide content — the application layer provides
 * a fully formed notification request.
 */

// ── Request / Response ─────────────────────────────────────────────

export type NotificationChannel = "email" | "sms" | "push";

export interface NotificationRequest {
  readonly event_id: string;
  readonly customer_id: string;
  readonly merchant_id: string;
  readonly channel: NotificationChannel;
  readonly subject: string;
  readonly body: string;
  /** Idempotency key — same key must not produce a duplicate send. */
  readonly idempotency_key: string;
}

export interface NotificationResponse {
  readonly sent: boolean;
  /** Provider-side message ID, if available. */
  readonly provider_ref: string | null;
  /** Human-readable error detail on failure. */
  readonly detail: string | null;
}

// ── Port interface ─────────────────────────────────────────────────

export interface NotificationGateway {
  /**
   * Send a notification to the customer.
   * Returns a result indicating success/failure.
   */
  send(request: NotificationRequest): Promise<NotificationResponse>;
}
