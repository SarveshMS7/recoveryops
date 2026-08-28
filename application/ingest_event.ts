/**
 * Application: ingestEvent
 *
 * Orchestration-only — no business logic.
 * Normalizes a raw inbound event, deduplicates on `dedupe_key`,
 * and writes both a `risk_event` row and an `outbox` row in a
 * single atomic operation (the adapter wraps them in one transaction).
 *
 * Returns the created RiskEvent, or null if the event was a duplicate.
 */

import type { EventRepository, InsertRiskEvent } from "../ports/event_repository.js";
import type { RiskEvent, SourceType } from "../ports/types.js";

// ── Raw inbound event shape ────────────────────────────────────────

export interface RawInboundEvent {
  /** e.g. "razorpay", "stripe", "internal" */
  readonly source: string;
  /** External reference — e.g. Razorpay payment_id, checkout_id */
  readonly external_ref: string;
  readonly merchant_id: string;
  readonly source_type: SourceType;
  readonly customer_id: string;
  readonly amount: number;
  readonly currency?: string;
  readonly raw_reason?: string | null;
}

// ── Normalizer ─────────────────────────────────────────────────────

/**
 * Build the dedupe_key from source + external_ref.
 * This must be deterministic and consistent — the same event from the
 * same source always produces the same key.
 */
export function buildDedupeKey(source: string, externalRef: string): string {
  return `${source}:${externalRef}`;
}

/**
 * Normalize a raw event into the InsertRiskEvent shape expected by
 * the repository.
 */
export function normalizeEvent(raw: RawInboundEvent): InsertRiskEvent {
  return {
    dedupe_key: buildDedupeKey(raw.source, raw.external_ref),
    merchant_id: raw.merchant_id,
    source_type: raw.source_type,
    customer_id: raw.customer_id,
    amount: raw.amount,
    currency: raw.currency ?? "INR",
    raw_reason: raw.raw_reason ?? null,
  };
}

// ── Use case ───────────────────────────────────────────────────────

/**
 * Ingest a single event: normalize → dedupe → atomic write
 * (risk_event + outbox in one transaction).
 *
 * @param repo  The event repository port (real or mock).
 * @param raw   The raw inbound event.
 * @returns     The created RiskEvent, or null if deduplicated.
 */
export async function ingestEvent(
  repo: EventRepository,
  raw: RawInboundEvent,
): Promise<RiskEvent | null> {
  const normalized = normalizeEvent(raw);

  const outboxPayload = {
    type: "event_ingested",
    dedupe_key: normalized.dedupe_key,
    source_type: normalized.source_type,
    merchant_id: normalized.merchant_id,
    amount: normalized.amount,
    currency: normalized.currency,
  };

  return repo.insertEventWithOutbox(normalized, outboxPayload);
}
