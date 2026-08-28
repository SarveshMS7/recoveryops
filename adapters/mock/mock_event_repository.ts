/**
 * Mock adapter: MockEventRepository
 *
 * In-memory fake implementing the EventRepository port.
 * Supports configurable failure injection via forceFailureFor().
 * All data is stored in plain Maps — no database, no I/O.
 */

import { randomUUID } from "node:crypto";
import type {
  EventRepository,
  InsertRiskEvent,
  InsertScore,
  InsertDecision,
  InsertPolicyCheck,
  InsertActionExecution,
  InsertAuditLog,
} from "../../ports/event_repository.js";
import type {
  RiskEvent,
  Score,
  Decision,
  PolicyCheckRecord,
  ActionExecution,
  OutboxRow,
  AuditLogEntry,
  RiskGroup,
} from "../../ports/types.js";

export class MockEventRepository implements EventRepository {
  // ── In-memory stores ─────────────────────────────────────────────
  readonly events = new Map<string, RiskEvent>();
  readonly scores = new Map<string, Score>();
  readonly decisions = new Map<string, Decision>();
  readonly policyChecks = new Map<string, PolicyCheckRecord[]>();
  readonly executions = new Map<string, ActionExecution[]>();
  readonly outbox = new Map<string, OutboxRow>();
  readonly auditLogs = new Map<string, AuditLogEntry[]>();
  readonly states = new Map<string, string>();

  private readonly dedupeIndex = new Map<string, string>(); // dedupe_key → event id
  private readonly idempotencyIndex = new Set<string>(); // idempotency_keys

  // ── Failure injection ────────────────────────────────────────────
  private readonly failureMap = new Map<string, number>(); // eventId → remaining failures

  /**
   * Configure the mock to throw on the next N calls involving `eventId`.
   */
  forceFailureFor(eventId: string, times: number): void {
    this.failureMap.set(eventId, times);
  }

  private checkFailure(eventId: string): void {
    const remaining = this.failureMap.get(eventId);
    if (remaining !== undefined && remaining > 0) {
      this.failureMap.set(eventId, remaining - 1);
      throw new Error(`MockEventRepository: injected failure for ${eventId}`);
    }
  }

  /** Reset all in-memory state. */
  reset(): void {
    this.events.clear();
    this.scores.clear();
    this.decisions.clear();
    this.policyChecks.clear();
    this.executions.clear();
    this.outbox.clear();
    this.auditLogs.clear();
    this.states.clear();
    this.dedupeIndex.clear();
    this.idempotencyIndex.clear();
    this.failureMap.clear();
  }

  // ── RiskEvent ──────────────────────────────────────────────────

  async insertEventWithOutbox(
    input: InsertRiskEvent,
    outboxPayload: unknown,
  ): Promise<RiskEvent | null> {
    // Dedupe check
    if (this.dedupeIndex.has(input.dedupe_key)) {
      return null;
    }

    const id = randomUUID();
    this.checkFailure(id);

    const event: RiskEvent = {
      id,
      dedupe_key: input.dedupe_key,
      merchant_id: input.merchant_id,
      source_type: input.source_type,
      customer_id: input.customer_id,
      amount: input.amount,
      currency: input.currency,
      raw_reason: input.raw_reason,
      detected_at: new Date(),
      group: null,
    };

    const outboxRow: OutboxRow = {
      id: randomUUID(),
      event_id: id,
      payload: outboxPayload,
      published: false,
      created_at: new Date(),
      published_at: null,
    };

    // Atomic — both go in or neither
    this.events.set(id, event);
    this.dedupeIndex.set(input.dedupe_key, id);
    this.outbox.set(outboxRow.id, outboxRow);

    return event;
  }

  async findEventById(id: string): Promise<RiskEvent | null> {
    return this.events.get(id) ?? null;
  }

  async findEventByDedupeKey(dedupeKey: string): Promise<RiskEvent | null> {
    const id = this.dedupeIndex.get(dedupeKey);
    if (!id) return null;
    return this.events.get(id) ?? null;
  }

  async findUnscoredEvents(): Promise<RiskEvent[]> {
    const scoredEventIds = new Set(
      [...this.scores.values()].map((s) => s.event_id),
    );
    return [...this.events.values()].filter((e) => !scoredEventIds.has(e.id));
  }

  async setGroup(eventId: string, group: RiskGroup): Promise<void> {
    const event = this.events.get(eventId);
    if (!event) throw new Error(`Event ${eventId} not found`);
    this.events.set(eventId, { ...event, group });
  }

  // ── Score ──────────────────────────────────────────────────────

  async insertScore(input: InsertScore): Promise<Score> {
    this.checkFailure(input.event_id);
    const score: Score = {
      id: randomUUID(),
      event_id: input.event_id,
      p_loss: input.p_loss,
      p_uplift: input.p_uplift,
      expected_value: input.expected_value,
      cost_estimate: input.cost_estimate,
      scored_at: new Date(),
    };
    this.scores.set(score.id, score);
    return score;
  }

  async findScoreByEventId(eventId: string): Promise<Score | null> {
    for (const score of this.scores.values()) {
      if (score.event_id === eventId) return score;
    }
    return null;
  }

  async findScoredUnallocatedEvents(): Promise<
    Array<{ event: RiskEvent; score: Score }>
  > {
    const result: Array<{ event: RiskEvent; score: Score }> = [];
    for (const score of this.scores.values()) {
      const event = this.events.get(score.event_id);
      if (!event) continue;
      // Not yet allocated/skipped/parked = group is null or state is still "Scored"
      const state = this.states.get(event.id);
      if (state === "Scored" || state === undefined) {
        result.push({ event, score });
      }
    }
    return result;
  }

  // ── Decision ───────────────────────────────────────────────────

  async insertDecision(input: InsertDecision): Promise<Decision> {
    this.checkFailure(input.event_id);
    const decision: Decision = {
      id: randomUUID(),
      event_id: input.event_id,
      root_cause_summary: input.root_cause_summary,
      selected_action: input.selected_action as Decision["selected_action"],
      rationale: input.rationale,
      decided_at: new Date(),
    };
    this.decisions.set(decision.id, decision);
    return decision;
  }

  async findDecisionByEventId(eventId: string): Promise<Decision | null> {
    for (const decision of this.decisions.values()) {
      if (decision.event_id === eventId) return decision;
    }
    return null;
  }

  // ── PolicyCheck ────────────────────────────────────────────────

  async insertPolicyCheck(input: InsertPolicyCheck): Promise<PolicyCheckRecord> {
    this.checkFailure(input.event_id);
    const record: PolicyCheckRecord = {
      id: randomUUID(),
      event_id: input.event_id,
      check_name: input.check_name,
      passed: input.passed,
      detail: input.detail,
      checked_at: new Date(),
    };
    const existing = this.policyChecks.get(input.event_id) ?? [];
    existing.push(record);
    this.policyChecks.set(input.event_id, existing);
    return record;
  }

  async findPolicyChecksByEventId(eventId: string): Promise<PolicyCheckRecord[]> {
    return this.policyChecks.get(eventId) ?? [];
  }

  // ── ActionExecution ────────────────────────────────────────────

  async insertActionExecution(
    input: InsertActionExecution,
  ): Promise<ActionExecution | null> {
    // Idempotency check
    if (this.idempotencyIndex.has(input.idempotency_key)) {
      return null;
    }

    this.checkFailure(input.event_id);

    const execution: ActionExecution = {
      id: randomUUID(),
      event_id: input.event_id,
      idempotency_key: input.idempotency_key,
      action: input.action,
      attempt_number: input.attempt_number,
      result: input.result,
      executed_at: new Date(),
    };

    this.idempotencyIndex.add(input.idempotency_key);
    const existing = this.executions.get(input.event_id) ?? [];
    existing.push(execution);
    this.executions.set(input.event_id, existing);

    return execution;
  }

  async findActionExecutionsByEventId(
    eventId: string,
  ): Promise<ActionExecution[]> {
    return this.executions.get(eventId) ?? [];
  }

  async findLatestExecution(eventId: string): Promise<ActionExecution | null> {
    const list = this.executions.get(eventId) ?? [];
    if (list.length === 0) return null;
    return list[list.length - 1]!;
  }

  async getMerchantDailySpend(
    merchantId: string,
    _today: Date,
  ): Promise<number> {
    let total = 0;
    for (const list of this.executions.values()) {
      for (const exec of list) {
        const event = this.events.get(exec.event_id);
        if (event && event.merchant_id === merchantId) {
          total += event.amount;
        }
      }
    }
    return total;
  }

  // ── Outbox ─────────────────────────────────────────────────────

  async findUnpublishedOutbox(limit: number): Promise<OutboxRow[]> {
    const unpublished = [...this.outbox.values()]
      .filter((row) => !row.published)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    return unpublished.slice(0, limit);
  }

  async markOutboxPublished(ids: string[]): Promise<void> {
    for (const id of ids) {
      const row = this.outbox.get(id);
      if (row) {
        this.outbox.set(id, {
          ...row,
          published: true,
          published_at: new Date(),
        });
      }
    }
  }

  // ── AuditLog ───────────────────────────────────────────────────

  async insertAuditLog(input: InsertAuditLog): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      id: randomUUID(),
      event_id: input.event_id,
      stage: input.stage,
      detail: input.detail,
      occurred_at: new Date(),
    };
    const eventId = input.event_id ?? "__global__";
    const existing = this.auditLogs.get(eventId) ?? [];
    existing.push(entry);
    this.auditLogs.set(eventId, existing);
    return entry;
  }

  async findAuditLogsByEventId(eventId: string): Promise<AuditLogEntry[]> {
    return this.auditLogs.get(eventId) ?? [];
  }

  // ── State tracking ─────────────────────────────────────────────

  async getCurrentState(eventId: string): Promise<string | null> {
    return this.states.get(eventId) ?? null;
  }

  async updateState(eventId: string, state: string): Promise<void> {
    this.states.set(eventId, state);
  }
}
