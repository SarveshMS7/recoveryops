/**
 * Tests for the RecoveryOps greedy allocator (Task 5).
 *
 * Coverage requirements (from TASKS.md):
 *   • A fixed, known input list
 *   • Asserts the *exact* selected set and *exact* skipped set
 *   • Not an approximate check
 *
 * Zero I/O — pure function tests.
 */

import { describe, it, expect } from "vitest";
import {
  allocate,
  type AllocatorInput,
} from "../../domain/allocator.js";

// ── Helpers ────────────────────────────────────────────────────────

/** Shorthand to build an input item. */
function item(event_id: string, expected_value: number, cost: number): AllocatorInput {
  return { event_id, expected_value, cost };
}

/** Extract just the IDs from a result set for easier assertions. */
function ids(items: readonly AllocatorInput[]): string[] {
  return items.map((i) => i.event_id);
}

// ═══════════════════════════════════════════════════════════════════
// 1. Core greedy selection with a fixed, known input
// ═══════════════════════════════════════════════════════════════════

describe("Allocator: greedy selection", () => {
  /**
   * Fixed input (5 events):
   *
   *   ID    EV     Cost   Ratio (EV/Cost)
   *   A     500    100    5.00    ← 2nd best ratio
   *   B     200    200    1.00    ← worst ratio
   *   C     900    150    6.00    ← best ratio
   *   D     300    100    3.00    ← 3rd best ratio
   *   E     100    50     2.00    ← 4th best ratio
   *
   * Sorted by ratio desc: C(6.0), A(5.0), D(3.0), E(2.0), B(1.0)
   *
   * Budget = 350:
   *   C: cost 150, remaining 200  → allocated
   *   A: cost 100, remaining 100  → allocated
   *   D: cost 100, remaining 0    → allocated
   *   E: cost 50,  remaining 0    → skipped (0 < 50)
   *   B: cost 200, remaining 0    → skipped (0 < 200)
   *
   * Selected: [C, A, D]  total_cost=350  remaining=0
   * Skipped:  [E, B]
   */
  const INPUT = [
    item("A", 500, 100),
    item("B", 200, 200),
    item("C", 900, 150),
    item("D", 300, 100),
    item("E", 100, 50),
  ];

  it("selects the exact set [C, A, D] with budget 350", () => {
    const result = allocate(INPUT, 350);
    expect(ids(result.allocated)).toEqual(["C", "A", "D"]);
  });

  it("skips the exact set [E, B] with budget 350", () => {
    const result = allocate(INPUT, 350);
    expect(ids(result.skipped)).toEqual(["E", "B"]);
  });

  it("reports total_cost = 350 and remaining_budget = 0", () => {
    const result = allocate(INPUT, 350);
    expect(result.total_cost).toBe(350);
    expect(result.remaining_budget).toBe(0);
  });

  it("returns the full event objects, not just IDs", () => {
    const result = allocate(INPUT, 350);
    expect(result.allocated[0]).toEqual(item("C", 900, 150));
    expect(result.allocated[1]).toEqual(item("A", 500, 100));
    expect(result.allocated[2]).toEqual(item("D", 300, 100));
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Edge cases
// ═══════════════════════════════════════════════════════════════════

describe("Allocator: edge cases", () => {
  it("allocates nothing when budget is 0", () => {
    const input = [item("A", 500, 100), item("B", 200, 50)];
    const result = allocate(input, 0);
    expect(ids(result.allocated)).toEqual([]);
    expect(ids(result.skipped)).toEqual(["A", "B"]);
    expect(result.total_cost).toBe(0);
  });

  it("allocates everything when budget is large enough", () => {
    const input = [item("A", 500, 100), item("B", 200, 50)];
    const result = allocate(input, 999);
    expect(ids(result.allocated)).toEqual(["A", "B"]);
    expect(ids(result.skipped)).toEqual([]);
    expect(result.total_cost).toBe(150);
    expect(result.remaining_budget).toBe(849);
  });

  it("handles empty input", () => {
    const result = allocate([], 1000);
    expect(result.allocated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.total_cost).toBe(0);
    expect(result.remaining_budget).toBe(1000);
  });

  it("skips an expensive item but takes a cheaper one behind it", () => {
    // Budget = 80: X costs 100 (skip), Y costs 60 (take)
    // X has better ratio (10 vs 5), but doesn't fit
    const input = [item("X", 1000, 100), item("Y", 300, 60)];
    const result = allocate(input, 80);
    expect(ids(result.allocated)).toEqual(["Y"]);
    expect(ids(result.skipped)).toEqual(["X"]);
    expect(result.total_cost).toBe(60);
  });

  it("handles zero-cost events (infinite ROI) — always selected first", () => {
    const input = [
      item("costly", 500, 100),
      item("free", 50, 0),
    ];
    const result = allocate(input, 100);
    // free has infinite ratio → selected first, then costly fits
    expect(ids(result.allocated)).toEqual(["free", "costly"]);
    expect(result.total_cost).toBe(100);
  });

  it("single event that exactly fits budget", () => {
    const input = [item("only", 1000, 500)];
    const result = allocate(input, 500);
    expect(ids(result.allocated)).toEqual(["only"]);
    expect(ids(result.skipped)).toEqual([]);
    expect(result.total_cost).toBe(500);
    expect(result.remaining_budget).toBe(0);
  });

  it("single event that exceeds budget by 1", () => {
    const input = [item("only", 1000, 501)];
    const result = allocate(input, 500);
    expect(ids(result.allocated)).toEqual([]);
    expect(ids(result.skipped)).toEqual(["only"]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Tie-breaking (stable sort — original order preserved)
// ═══════════════════════════════════════════════════════════════════

describe("Allocator: tie-breaking", () => {
  it("preserves original order for equal-ratio events", () => {
    // All have ratio = 2.0
    const input = [
      item("first", 200, 100),
      item("second", 100, 50),
      item("third", 400, 200),
    ];
    const result = allocate(input, 150);
    // Sorted: all ratio=2, so original order: first, second, third
    // first: cost 100, remaining 50 → allocated
    // second: cost 50, remaining 0 → allocated
    // third: cost 200, remaining 0 → skipped
    expect(ids(result.allocated)).toEqual(["first", "second"]);
    expect(ids(result.skipped)).toEqual(["third"]);
  });
});
