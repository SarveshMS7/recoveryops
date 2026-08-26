/**
 * RecoveryOps greedy allocator — pure function, no I/O.
 *
 * Given a list of scored events (each with expected_value and cost)
 * and a total budget, selects events greedily by expected_value/cost
 * descending until the budget is exhausted.
 *
 * Events whose cost would exceed the remaining budget are skipped.
 * Zero-cost events are always selected first (infinite ROI).
 */

// ── Types ──────────────────────────────────────────────────────────

export interface AllocatorInput {
  readonly event_id: string;
  readonly expected_value: number;
  readonly cost: number;
}

export interface AllocationResult {
  /** Events selected for action, in allocation order. */
  readonly allocated: readonly AllocatorInput[];
  /** Events not funded, in their sorted order. */
  readonly skipped: readonly AllocatorInput[];
  /** Total cost of allocated events. */
  readonly total_cost: number;
  /** Remaining unspent budget. */
  readonly remaining_budget: number;
}

// ── Allocator ──────────────────────────────────────────────────────

/**
 * Greedy allocator: sort by expected_value/cost descending, then
 * pick events in order while their cost fits within the budget.
 *
 * Tie-breaking: when two events have the same ratio, the one
 * appearing first in the input array is picked first (stable sort).
 *
 * @param events  Candidate events with expected_value and cost.
 * @param budget  Total available budget (same currency as cost).
 * @returns       The allocated and skipped sets, plus totals.
 */
export function allocate(
  events: readonly AllocatorInput[],
  budget: number,
): AllocationResult {
  // Compute ROI for sorting.  Zero-cost events get +Infinity ratio.
  const withRatio = events.map((e, originalIndex) => ({
    event: e,
    ratio: e.cost === 0 ? Number.POSITIVE_INFINITY : e.expected_value / e.cost,
    originalIndex,
  }));

  // Sort descending by ratio, stable (preserve original order on ties).
  withRatio.sort((a, b) => {
    if (b.ratio !== a.ratio) return b.ratio - a.ratio;
    return a.originalIndex - b.originalIndex;
  });

  const allocated: AllocatorInput[] = [];
  const skipped: AllocatorInput[] = [];
  let remaining = budget;

  for (const entry of withRatio) {
    if (entry.event.cost <= remaining) {
      allocated.push(entry.event);
      remaining -= entry.event.cost;
    } else {
      skipped.push(entry.event);
    }
  }

  return {
    allocated,
    skipped,
    total_cost: budget - remaining,
    remaining_budget: remaining,
  };
}
