/**
 * Postgres adapter: PgEventRepository
 *
 * Real implementation of the EventRepository port backed by PostgreSQL.
 * Uses the `pg` library directly (no ORM — per stack rules).
 *
 * Transaction semantics: insertEventWithOutbox wraps both writes in a
 * single BEGIN/COMMIT so that a crash mid-operation leaves no partial data.
 * Dedupe and idempotency are enforced by Postgres UNIQUE constraints.
 */

import pg from "pg";
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
  SourceType,
  ExecutionResult,
} from "../../ports/types.js";

const { Pool } = pg;
type PoolType = InstanceType<typeof Pool>;
type PoolClient = pg.PoolClient;

// ── Row mappers ────────────────────────────────────────────────────

function mapRiskEvent(row: Record<string, unknown>): RiskEvent {
  return {
    id: row["id"] as string,
    dedupe_key: row["dedupe_key"] as string,
    merchant_id: row["merchant_id"] as string,
    source_type: row["source_type"] as SourceType,
    customer_id: row["customer_id"] as string,
    amount: Number(row["amount"]),
    currency: row["currency"] as string,
    raw_reason: (row["raw_reason"] as string) ?? null,
    detected_at: new Date(row["detected_at"] as string),
    group: (row["group"] as RiskGroup) ?? null,
  };
}

function mapScore(row: Record<string, unknown>): Score {
  return {
    id: row["id"] as string,
    event_id: row["event_id"] as string,
    p_loss: Number(row["p_loss"]),
    p_uplift: Number(row["p_uplift"]),
    expected_value: Number(row["expected_value"]),
    cost_estimate: Number(row["cost_estimate"]),
    scored_at: new Date(row["scored_at"] as string),
  };
}

function mapDecision(row: Record<string, unknown>): Decision {
  return {
    id: row["id"] as string,
    event_id: row["event_id"] as string,
    root_cause_summary: row["root_cause_summary"] as string,
    selected_action: row["selected_action"] as Decision["selected_action"],
    rationale: row["rationale"] as string,
    decided_at: new Date(row["decided_at"] as string),
  };
}

function mapPolicyCheck(row: Record<string, unknown>): PolicyCheckRecord {
  return {
    id: row["id"] as string,
    event_id: row["event_id"] as string,
    check_name: row["check_name"] as string,
    passed: row["passed"] as boolean,
    detail: (row["detail"] as string) ?? null,
    checked_at: new Date(row["checked_at"] as string),
  };
}

function mapActionExecution(row: Record<string, unknown>): ActionExecution {
  return {
    id: row["id"] as string,
    event_id: row["event_id"] as string,
    idempotency_key: row["idempotency_key"] as string,
    action: row["action"] as string,
    attempt_number: Number(row["attempt_number"]),
    result: row["result"] as ExecutionResult,
    executed_at: new Date(row["executed_at"] as string),
  };
}

function mapOutboxRow(row: Record<string, unknown>): OutboxRow {
  return {
    id: row["id"] as string,
    event_id: row["event_id"] as string,
    payload: row["payload"],
    published: row["published"] as boolean,
    created_at: new Date(row["created_at"] as string),
    published_at: row["published_at"]
      ? new Date(row["published_at"] as string)
      : null,
  };
}

function mapAuditLog(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: row["id"] as string,
    event_id: (row["event_id"] as string) ?? null,
    stage: row["stage"] as string,
    detail: row["detail"],
    occurred_at: new Date(row["occurred_at"] as string),
  };
}

// ── Adapter ────────────────────────────────────────────────────────

export class PgEventRepository implements EventRepository {
  constructor(private readonly pool: PoolType) {}

  // ── RiskEvent ──────────────────────────────────────────────────

  async insertEventWithOutbox(
    event: InsertRiskEvent,
    outboxPayload: unknown,
  ): Promise<RiskEvent | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const eventId = randomUUID();
      const outboxId = randomUUID();

      // Insert risk_event — dedupe_key has a UNIQUE constraint.
      // ON CONFLICT DO NOTHING so duplicates silently return 0 rows.
      const eventResult = await client.query(
        `INSERT INTO risk_event (id, dedupe_key, merchant_id, source_type, customer_id, amount, currency, raw_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING *`,
        [
          eventId,
          event.dedupe_key,
          event.merchant_id,
          event.source_type,
          event.customer_id,
          event.amount,
          event.currency,
          event.raw_reason,
        ],
      );

      if (eventResult.rows.length === 0) {
        // Deduplicated — roll back (nothing was committed)
        await client.query("ROLLBACK");
        return null;
      }

      // Insert outbox row in the same transaction
      await client.query(
        `INSERT INTO outbox (id, event_id, payload)
         VALUES ($1, $2, $3)`,
        [outboxId, eventId, JSON.stringify(outboxPayload)],
      );

      await client.query("COMMIT");

      return mapRiskEvent(eventResult.rows[0] as Record<string, unknown>);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async findEventById(id: string): Promise<RiskEvent | null> {
    const result = await this.pool.query(
      "SELECT * FROM risk_event WHERE id = $1",
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapRiskEvent(result.rows[0] as Record<string, unknown>);
  }

  async findEventByDedupeKey(dedupeKey: string): Promise<RiskEvent | null> {
    const result = await this.pool.query(
      "SELECT * FROM risk_event WHERE dedupe_key = $1",
      [dedupeKey],
    );
    if (result.rows.length === 0) return null;
    return mapRiskEvent(result.rows[0] as Record<string, unknown>);
  }

  async findUnscoredEvents(): Promise<RiskEvent[]> {
    const result = await this.pool.query(
      `SELECT re.* FROM risk_event re
       LEFT JOIN score s ON s.event_id = re.id
       WHERE s.id IS NULL`,
    );
    return (result.rows as Record<string, unknown>[]).map(mapRiskEvent);
  }

  async setGroup(eventId: string, group: RiskGroup): Promise<void> {
    await this.pool.query(
      `UPDATE risk_event SET "group" = $1 WHERE id = $2`,
      [group, eventId],
    );
  }

  // ── Score ──────────────────────────────────────────────────────

  async insertScore(input: InsertScore): Promise<Score> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO score (id, event_id, p_loss, p_uplift, expected_value, cost_estimate)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, input.event_id, input.p_loss, input.p_uplift, input.expected_value, input.cost_estimate],
    );
    return mapScore(result.rows[0] as Record<string, unknown>);
  }

  async findScoreByEventId(eventId: string): Promise<Score | null> {
    const result = await this.pool.query(
      "SELECT * FROM score WHERE event_id = $1",
      [eventId],
    );
    if (result.rows.length === 0) return null;
    return mapScore(result.rows[0] as Record<string, unknown>);
  }

  async findScoredUnallocatedEvents(): Promise<
    Array<{ event: RiskEvent; score: Score }>
  > {
    // Events that have a score and whose latest state is "Scored"
    // (not yet allocated/skipped/parked).  The state is tracked via
    // audit_log entries written by updateState().
    const result = await this.pool.query(
      `SELECT re.*, s.id AS s_id, s.event_id AS s_event_id,
              s.p_loss AS s_p_loss, s.p_uplift AS s_p_uplift,
              s.expected_value AS s_expected_value, s.cost_estimate AS s_cost_estimate,
              s.scored_at AS s_scored_at
       FROM risk_event re
       JOIN score s ON s.event_id = re.id
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_log al
         WHERE al.event_id = re.id
           AND al.stage IN ('Allocated', 'Skipped', 'Parked_Control')
       )`,
    );
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      event: mapRiskEvent(row),
      score: mapScore({
        id: row["s_id"],
        event_id: row["s_event_id"],
        p_loss: row["s_p_loss"],
        p_uplift: row["s_p_uplift"],
        expected_value: row["s_expected_value"],
        cost_estimate: row["s_cost_estimate"],
        scored_at: row["s_scored_at"],
      } as Record<string, unknown>),
    }));
  }

  // ── Decision ───────────────────────────────────────────────────

  async insertDecision(input: InsertDecision): Promise<Decision> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO decision (id, event_id, root_cause_summary, selected_action, rationale)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, input.event_id, input.root_cause_summary, input.selected_action, input.rationale],
    );
    return mapDecision(result.rows[0] as Record<string, unknown>);
  }

  async findDecisionByEventId(eventId: string): Promise<Decision | null> {
    const result = await this.pool.query(
      "SELECT * FROM decision WHERE event_id = $1",
      [eventId],
    );
    if (result.rows.length === 0) return null;
    return mapDecision(result.rows[0] as Record<string, unknown>);
  }

  // ── PolicyCheck ────────────────────────────────────────────────

  async insertPolicyCheck(input: InsertPolicyCheck): Promise<PolicyCheckRecord> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO policy_check (id, event_id, check_name, passed, detail)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, input.event_id, input.check_name, input.passed, input.detail],
    );
    return mapPolicyCheck(result.rows[0] as Record<string, unknown>);
  }

  async findPolicyChecksByEventId(eventId: string): Promise<PolicyCheckRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM policy_check WHERE event_id = $1",
      [eventId],
    );
    return (result.rows as Record<string, unknown>[]).map(mapPolicyCheck);
  }

  // ── ActionExecution ────────────────────────────────────────────

  async insertActionExecution(
    input: InsertActionExecution,
  ): Promise<ActionExecution | null> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO action_execution (id, event_id, idempotency_key, action, attempt_number, result)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [id, input.event_id, input.idempotency_key, input.action, input.attempt_number, input.result],
    );
    if (result.rows.length === 0) return null;
    return mapActionExecution(result.rows[0] as Record<string, unknown>);
  }

  async findActionExecutionsByEventId(eventId: string): Promise<ActionExecution[]> {
    const result = await this.pool.query(
      "SELECT * FROM action_execution WHERE event_id = $1 ORDER BY attempt_number",
      [eventId],
    );
    return (result.rows as Record<string, unknown>[]).map(mapActionExecution);
  }

  async findLatestExecution(eventId: string): Promise<ActionExecution | null> {
    const result = await this.pool.query(
      "SELECT * FROM action_execution WHERE event_id = $1 ORDER BY attempt_number DESC LIMIT 1",
      [eventId],
    );
    if (result.rows.length === 0) return null;
    return mapActionExecution(result.rows[0] as Record<string, unknown>);
  }

  async getMerchantDailySpend(merchantId: string, today: Date): Promise<number> {
    const dayStart = new Date(today);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const result = await this.pool.query(
      `SELECT COALESCE(SUM(re.amount), 0) AS total
       FROM action_execution ae
       JOIN risk_event re ON re.id = ae.event_id
       WHERE re.merchant_id = $1
         AND ae.executed_at >= $2
         AND ae.executed_at < $3`,
      [merchantId, dayStart, dayEnd],
    );
    return Number((result.rows[0] as Record<string, unknown>)["total"]);
  }

  // ── Outbox ─────────────────────────────────────────────────────

  async findUnpublishedOutbox(limit: number): Promise<OutboxRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM outbox WHERE published = false ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return (result.rows as Record<string, unknown>[]).map(mapOutboxRow);
  }

  async markOutboxPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      `UPDATE outbox SET published = true, published_at = now() WHERE id = ANY($1)`,
      [ids],
    );
  }

  // ── AuditLog ───────────────────────────────────────────────────

  async insertAuditLog(input: InsertAuditLog): Promise<AuditLogEntry> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO audit_log (id, event_id, stage, detail)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, input.event_id, input.stage, JSON.stringify(input.detail)],
    );
    return mapAuditLog(result.rows[0] as Record<string, unknown>);
  }

  async findAuditLogsByEventId(eventId: string): Promise<AuditLogEntry[]> {
    const result = await this.pool.query(
      "SELECT * FROM audit_log WHERE event_id = $1 ORDER BY occurred_at",
      [eventId],
    );
    return (result.rows as Record<string, unknown>[]).map(mapAuditLog);
  }

  // ── State tracking ─────────────────────────────────────────────
  // State is derived / tracked externally for now; these are convenience
  // methods that read/write a lightweight state column if present,
  // or use an audit-log-based derivation.

  async getCurrentState(eventId: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT stage FROM audit_log WHERE event_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [eventId],
    );
    if (result.rows.length === 0) return null;
    return (result.rows[0] as Record<string, unknown>)["stage"] as string;
  }

  async updateState(eventId: string, state: string): Promise<void> {
    // Persist as an audit log entry so state history is tracked
    await this.insertAuditLog({
      event_id: eventId,
      stage: state,
      detail: { transitioned_to: state },
    });
  }
}
