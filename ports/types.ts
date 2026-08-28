/**
 * Shared data types used across ports.
 *
 * These are plain data transfer objects — no I/O, no framework imports.
 * They mirror the Postgres schema from ARCHITECTURE.md, but are defined
 * here so ports/ and application/ can reference them without importing
 * domain/ entities directly (keeping the dependency direction clean).
 */

// ── Source type enum ───────────────────────────────────────────────

export type SourceType =
  | "payment_failure"
  | "checkout_abandon"
  | "subscription"
  | "receivable";

// ── Risk group ─────────────────────────────────────────────────────

export type RiskGroup = "treatment" | "control";

// ── Selected action (closed enum — LLM output is restricted to this) ─

export type SelectedAction =
  | "retry_now"
  | "retry_delayed"
  | "send_reminder"
  | "offer_alt_method"
  | "escalate"
  | "none";

export const VALID_ACTIONS: readonly SelectedAction[] = [
  "retry_now",
  "retry_delayed",
  "send_reminder",
  "offer_alt_method",
  "escalate",
  "none",
] as const;

// ── Execution result ───────────────────────────────────────────────

export type ExecutionResult = "success" | "failed" | "timeout";

// ── Entity shapes ──────────────────────────────────────────────────

export interface RiskEvent {
  readonly id: string;
  readonly dedupe_key: string;
  readonly merchant_id: string;
  readonly source_type: SourceType;
  readonly customer_id: string;
  readonly amount: number;
  readonly currency: string;
  readonly raw_reason: string | null;
  readonly detected_at: Date;
  readonly group: RiskGroup | null;
}

export interface Score {
  readonly id: string;
  readonly event_id: string;
  readonly p_loss: number;
  readonly p_uplift: number;
  readonly expected_value: number;
  readonly cost_estimate: number;
  readonly scored_at: Date;
}

export interface Decision {
  readonly id: string;
  readonly event_id: string;
  readonly root_cause_summary: string;
  readonly selected_action: SelectedAction;
  readonly rationale: string;
  readonly decided_at: Date;
}

export interface PolicyCheckRecord {
  readonly id: string;
  readonly event_id: string;
  readonly check_name: string;
  readonly passed: boolean;
  readonly detail: string | null;
  readonly checked_at: Date;
}

export interface ActionExecution {
  readonly id: string;
  readonly event_id: string;
  readonly idempotency_key: string;
  readonly action: string;
  readonly attempt_number: number;
  readonly result: ExecutionResult;
  readonly executed_at: Date;
}

export interface OutboxRow {
  readonly id: string;
  readonly event_id: string;
  readonly payload: unknown;
  readonly published: boolean;
  readonly created_at: Date;
  readonly published_at: Date | null;
}

export interface AuditLogEntry {
  readonly id: string;
  readonly event_id: string | null;
  readonly stage: string;
  readonly detail: unknown;
  readonly occurred_at: Date;
}
