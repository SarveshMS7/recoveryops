/**
 * Port: PaymentGateway
 *
 * Abstracts the Razorpay payment API (or any payment processor).
 * Adapters: adapters/razorpay/ (real, test-mode), adapters/mock/ (fake).
 *
 * Every action returns a result enum — the application layer maps this
 * to state-machine transitions.  The gateway never decides what to do;
 * it only executes what the application layer tells it to.
 */

import type { ExecutionResult, SelectedAction } from "./types.js";

// ── Request / Response ─────────────────────────────────────────────

export interface PaymentActionRequest {
  /** The risk event this action is for. */
  readonly event_id: string;
  /** Razorpay payment ID or equivalent external reference. */
  readonly external_ref: string;
  /** Which action to take — from the closed enum. */
  readonly action: SelectedAction;
  /** Amount in the smallest currency unit (paise for INR). */
  readonly amount: number;
  readonly currency: string;
  /** Idempotency key to prevent duplicate execution. */
  readonly idempotency_key: string;
}

export interface PaymentActionResponse {
  readonly result: ExecutionResult;
  /** Gateway-side reference (e.g. Razorpay refund_id). */
  readonly gateway_ref: string | null;
  /** Human-readable detail on failure/timeout. */
  readonly detail: string | null;
}

// ── Port interface ─────────────────────────────────────────────────

export interface PaymentGateway {
  /**
   * Execute a payment recovery action.
   *
   * The adapter is responsible for mapping `action` to the correct
   * Razorpay API call (retry, refund, etc.) and returning a normalised
   * result.
   */
  executeAction(request: PaymentActionRequest): Promise<PaymentActionResponse>;
}
