/**
 * Application: runAllocationPass
 *
 * Orchestration-only — no business logic.
 * Fetches all scored-but-unallocated events, separates control from
 * treatment, parks the control group (Scored → Parked_Control), then
 * runs the pure `allocate()` function from domain/allocator.ts on the
 * treatment group to decide which events get funded (Scored → Allocated)
 * and which are skipped (Scored → Skipped).
 *
 * After this pass, every event that was in "Scored" state ends up in
 * exactly one of {Parked_Control, Allocated, Skipped} — no overlaps,
 * no omissions.
 */

import type { EventRepository } from "../ports/event_repository.js";
import type { RiskEvent, Score } from "../ports/types.js";
import { allocate, type AllocatorInput } from "../domain/allocator.js";
import { transition, EventState } from "../domain/state_machine.js";

// ── Allocation pass result ─────────────────────────────────────────

export interface AllocationPassResult {
  /** Total events processed in this pass. */
  readonly total: number;
  /** Events parked as control holdout. */
  readonly parked_control: number;
  /** Events allocated (funded for action). */
  readonly allocated: number;
  /** Events skipped (treatment but not funded). */
  readonly skipped: number;
  /** Total cost of allocated events. */
  readonly total_cost: number;
  /** Remaining budget after allocation. */
  readonly remaining_budget: number;
}

// ── Use case ───────────────────────────────────────────────────────

/**
 * Run an allocation pass over all scored-but-unallocated events.
 *
 * Steps:
 *   1. Fetch all scored, unallocated events (with their scores)
 *   2. Separate control group → transition to Parked_Control
 *   3. Feed treatment group into the greedy allocator
 *   4. Transition allocated events to Allocated
 *   5. Transition unfunded events to Skipped
 *   6. Write audit log entries for all transitions
 *
 * @param repo    EventRepository port
 * @param budget  Total budget for this allocation cycle
 */
export async function runAllocationPass(
  repo: EventRepository,
  budget: number,
): Promise<AllocationPassResult> {
  const scoredEvents = await repo.findScoredUnallocatedEvents();

  if (scoredEvents.length === 0) {
    return {
      total: 0,
      parked_control: 0,
      allocated: 0,
      skipped: 0,
      total_cost: 0,
      remaining_budget: budget,
    };
  }

  // ── Step 1: Separate control from treatment ───────────────────

  const controlEvents: Array<{ event: RiskEvent; score: Score }> = [];
  const treatmentEvents: Array<{ event: RiskEvent; score: Score }> = [];

  for (const entry of scoredEvents) {
    if (entry.event.group === "control") {
      controlEvents.push(entry);
    } else {
      treatmentEvents.push(entry);
    }
  }

  // ── Step 2: Park control group ────────────────────────────────

  for (const { event } of controlEvents) {
    await repo.insertAuditLog({
      event_id: event.id,
      stage: "parked_control_detail",
      detail: { reason: "holdout_group", group: "control" },
    });

    // State is known to be Scored (from findScoredUnallocatedEvents)
    const newState = transition(EventState.Scored, EventState.Parked_Control);
    await repo.updateState(event.id, newState);
  }

  // ── Step 3: Run allocator on treatment group ──────────────────

  const allocatorInputs: AllocatorInput[] = treatmentEvents.map(({ event, score }) => ({
    event_id: event.id,
    expected_value: score.expected_value,
    cost: score.cost_estimate,
  }));

  const result = allocate(allocatorInputs, budget);

  // Build a Set of allocated event IDs for O(1) lookup
  const allocatedIds = new Set(result.allocated.map((a) => a.event_id));

  // ── Step 4: Transition allocated events ───────────────────────

  for (const { event, score } of treatmentEvents) {
    if (allocatedIds.has(event.id)) {
      await repo.insertAuditLog({
        event_id: event.id,
        stage: "allocated_detail",
        detail: {
          expected_value: score.expected_value,
          cost_estimate: score.cost_estimate,
          group: "treatment",
        },
      });

      // State is known to be Scored (from findScoredUnallocatedEvents)
      const newState = transition(EventState.Scored, EventState.Allocated);
      await repo.updateState(event.id, newState);
    } else {
      // ── Step 5: Transition skipped events ─────────────────────

      await repo.insertAuditLog({
        event_id: event.id,
        stage: "skipped_detail",
        detail: {
          expected_value: score.expected_value,
          cost_estimate: score.cost_estimate,
          group: "treatment",
          reason: "budget_exhausted",
        },
      });

      // State is known to be Scored (from findScoredUnallocatedEvents)
      const newState = transition(EventState.Scored, EventState.Skipped);
      await repo.updateState(event.id, newState);
    }
  }

  return {
    total: scoredEvents.length,
    parked_control: controlEvents.length,
    allocated: result.allocated.length,
    skipped: result.skipped.length,
    total_cost: result.total_cost,
    remaining_budget: result.remaining_budget,
  };
}
