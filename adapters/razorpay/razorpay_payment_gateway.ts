/**
 * Real adapter: RazorpayPaymentGateway
 *
 * Implements the PaymentGateway port against Razorpay's REST API v1,
 * using raw `fetch()` (zero extra npm dependencies).
 *
 * Action mapping:
 *   retry_now        → POST /payment_links  (immediate)
 *   retry_delayed    → POST /payment_links  (future expiry)
 *   send_reminder    → POST /payment_links  (reminder_enable = true)
 *   offer_alt_method → POST /payment_links  (customer picks method)
 *   escalate         → no-op  (returns success immediately)
 *   none             → no-op  (returns success immediately)
 *
 * Idempotency:
 *   - `receipt` field on payment links (unique per Razorpay account)
 *   - sanitised to satisfy Razorpay's receipt constraints
 *
 * Credentials: reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from env
 * or from the constructor config object.
 */

import type {
  PaymentGateway,
  PaymentActionRequest,
  PaymentActionResponse,
} from "../../ports/payment_gateway.js";

// ── Configuration ─────────────────────────────────────────────────

export interface RazorpayConfig {
  readonly key_id: string;
  readonly key_secret: string;
  /** Override for testing. Defaults to https://api.razorpay.com */
  readonly base_url?: string;
  /** Request timeout in ms. Defaults to 30 000. */
  readonly timeout_ms?: number;
}

// ── Adapter ───────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.razorpay.com";
const DEFAULT_TIMEOUT_MS = 30_000;

export class RazorpayPaymentGateway implements PaymentGateway {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config?: RazorpayConfig) {
    const keyId = config?.key_id ?? process.env.RAZORPAY_KEY_ID;
    const keySecret = config?.key_secret ?? process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      throw new Error(
        "RazorpayPaymentGateway: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required " +
          "(pass via constructor config or environment variables).",
      );
    }

    this.authHeader =
      "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    this.baseUrl = (config?.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = config?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  // ── Observability & Controllability (Test Fakes) ───────────────

  readonly calls: PaymentActionRequest[] = [];
  private readonly failureMap = new Map<string, number>();

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

  reset(): void {
    this.calls.length = 0;
    this.failureMap.clear();
  }

  // ── Port implementation ────────────────────────────────────────

  async executeAction(
    request: PaymentActionRequest,
  ): Promise<PaymentActionResponse> {
    this.calls.push(request);

    if (this.consumeFailure(request.event_id)) {
      return {
        result: "failed",
        gateway_ref: null,
        detail: "RazorpayPaymentGateway: injected failure",
      };
    }

    // No-op actions — no gateway call needed
    if (request.action === "escalate" || request.action === "none") {
      return {
        result: "success",
        gateway_ref: null,
        detail: `Action "${request.action}" requires no gateway call.`,
      };
    }

    try {
      const body = this.buildPaymentLinkBody(request);
      const response = await this.post("/v1/payment_links", body);

      if (response.ok) {
        const data = (await response.json()) as { id?: string };
        return {
          result: "success",
          gateway_ref: data.id ?? null,
          detail: null,
        };
      }

      return await this.handleErrorResponse(response);
    } catch (error: unknown) {
      return this.handleNetworkError(error);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * Build the JSON body for `POST /v1/payment_links`.
   * Action-specific tweaks are applied on top of a common base.
   */
  private buildPaymentLinkBody(
    request: PaymentActionRequest,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      amount: request.amount,
      currency: request.currency,
      description: `Recovery: ${request.action} for event ${request.event_id}`,
      receipt: this.sanitiseReceipt(request.idempotency_key),
      reference_id: request.external_ref,
    };

    switch (request.action) {
      case "retry_now":
        // Immediate payment link — no extra fields
        break;

      case "retry_delayed": {
        // Expire in 24 hours
        const expireBy = Math.floor(Date.now() / 1000) + 86_400;
        base.expire_by = expireBy;
        break;
      }

      case "send_reminder":
        base.reminder_enable = true;
        break;

      case "offer_alt_method":
        // Standard payment link — customer picks method at checkout
        break;

      default:
        // Should never happen (escalate/none handled above), but be safe
        break;
    }

    return base;
  }

  /**
   * Razorpay `receipt` field constraints:
   *   - max 40 characters
   *   - alphanumeric, hyphens, underscores only
   */
  private sanitiseReceipt(raw: string): string {
    return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  }

  /**
   * Fire a POST request against the Razorpay API with Basic auth
   * and a timeout via AbortController.
   */
  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.authHeader,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Map an HTTP error response to a PaymentActionResponse.
   *   4xx → "failed"  (client error, non-retryable)
   *   5xx → "timeout" (server error, retryable)
   */
  private async handleErrorResponse(
    response: Response,
  ): Promise<PaymentActionResponse> {
    let detail: string;
    try {
      const errBody = (await response.json()) as {
        error?: { description?: string };
      };
      detail =
        errBody.error?.description ??
        `Razorpay HTTP ${response.status}`;
    } catch {
      detail = `Razorpay HTTP ${response.status} (unparseable body)`;
    }

    if (response.status >= 400 && response.status < 500) {
      return { result: "failed", gateway_ref: null, detail };
    }

    return { result: "timeout", gateway_ref: null, detail };
  }

  /**
   * Map a network / abort error to a PaymentActionResponse.
   * Always treated as retryable ("timeout").
   */
  private handleNetworkError(error: unknown): PaymentActionResponse {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      result: "timeout",
      gateway_ref: null,
      detail: `Razorpay request failed: ${message}`,
    };
  }
}
