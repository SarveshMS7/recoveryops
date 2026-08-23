/**
 * Table-driven unit tests for the RecoveryOps state machine.
 *
 * Coverage requirements (from TASKS.md Task 3):
 *   • Every legal transition
 *   • At least one illegal transition per state
 *   • Explicit illegal cases for terminal → Executing transitions:
 *       Succeeded → Executing
 *       Stopped   → Executing
 *       Escalated → Executing
 *       Detected  → Executing  (skip past every intermediate)
 *
 * Zero I/O — no database, no network calls.
 */

import { describe, it, expect } from "vitest";
import {
  EventState,
  transition,
  isTerminal,
  allowedTransitions,
  IllegalTransitionError,
  ALL_STATES,
} from "../../domain/state_machine.js";

// ─────────────────────────────────────────────────────────────────────
// 1. Legal transitions — every edge in the ARCHITECTURE.md diagram
// ─────────────────────────────────────────────────────────────────────

const LEGAL_TRANSITIONS: Array<{ from: EventState; to: EventState }> = [
  // Detected → Scored
  { from: EventState.Detected, to: EventState.Scored },

  // Scored → three branches
  { from: EventState.Scored, to: EventState.Parked_Control },
  { from: EventState.Scored, to: EventState.Skipped },
  { from: EventState.Scored, to: EventState.Allocated },

  // Allocated → ActionSelected
  { from: EventState.Allocated, to: EventState.ActionSelected },

  // ActionSelected → two branches
  { from: EventState.ActionSelected, to: EventState.PolicyRejected },
  { from: EventState.ActionSelected, to: EventState.PolicyApproved },

  // PolicyRejected → Escalated
  { from: EventState.PolicyRejected, to: EventState.Escalated },

  // PolicyApproved → Executing
  { from: EventState.PolicyApproved, to: EventState.Executing },

  // Executing → two branches
  { from: EventState.Executing, to: EventState.Succeeded },
  { from: EventState.Executing, to: EventState.Failed },

  // Failed → three branches (retry, stop, escalate)
  { from: EventState.Failed, to: EventState.Executing },
  { from: EventState.Failed, to: EventState.Stopped },
  { from: EventState.Failed, to: EventState.Escalated },
];

describe("State machine — legal transitions", () => {
  it.each(LEGAL_TRANSITIONS)(
    "$from → $to should succeed",
    ({ from, to }) => {
      const result = transition(from, to);
      expect(result).toBe(to);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────
// 2. Illegal transitions — at least one per state
// ─────────────────────────────────────────────────────────────────────

/**
 * For every state, we pick at least one target that is definitely not
 * in its legal set, making sure the test is meaningful (not just a
 * self-transition, which is always illegal anyway).
 */
const ILLEGAL_PER_STATE: Array<{
  from: EventState;
  to: EventState;
  why: string;
}> = [
  // ── Non-terminal states ────────────────────────────────────────
  {
    from: EventState.Detected,
    to: EventState.Executing,
    why: "skip past every intermediate state",
  },
  {
    from: EventState.Scored,
    to: EventState.Executing,
    why: "skip allocated/action/policy",
  },
  {
    from: EventState.Allocated,
    to: EventState.Succeeded,
    why: "skip action/policy/executing",
  },
  {
    from: EventState.ActionSelected,
    to: EventState.Executing,
    why: "skip policy check",
  },
  {
    from: EventState.PolicyRejected,
    to: EventState.Executing,
    why: "rejected policy must not reach executor",
  },
  {
    from: EventState.PolicyApproved,
    to: EventState.Succeeded,
    why: "must go through Executing first",
  },
  {
    from: EventState.Executing,
    to: EventState.Detected,
    why: "cannot restart pipeline from middle",
  },
  {
    from: EventState.Failed,
    to: EventState.Succeeded,
    why: "Failed cannot jump to Succeeded, must go via Executing",
  },

  // ── Terminal states — the user's four explicit requirements ─────
  {
    from: EventState.Succeeded,
    to: EventState.Executing,
    why: "already succeeded — must not re-fire",
  },
  {
    from: EventState.Stopped,
    to: EventState.Executing,
    why: "stopped after retry limit — must not re-fire",
  },
  {
    from: EventState.Escalated,
    to: EventState.Executing,
    why: "escalated (hard decline) — must not re-fire",
  },

  // ── Other terminal states ──────────────────────────────────────
  {
    from: EventState.Parked_Control,
    to: EventState.Allocated,
    why: "control group events must never be actioned",
  },
  {
    from: EventState.Skipped,
    to: EventState.Allocated,
    why: "skipped events must not be retroactively allocated",
  },
];

describe("State machine — illegal transitions (at least one per state)", () => {
  it.each(ILLEGAL_PER_STATE)(
    "$from → $to should throw ($why)",
    ({ from, to }) => {
      expect(() => transition(from, to)).toThrowError(IllegalTransitionError);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────
// 3. Explicit checks for terminal → Executing (user-requested)
// ─────────────────────────────────────────────────────────────────────

describe("Terminal states must never transition to Executing", () => {
  const terminalToExecuting: Array<{
    from: EventState;
    description: string;
  }> = [
    {
      from: EventState.Succeeded,
      description: "Succeeded → Executing: already-recovered event re-fired",
    },
    {
      from: EventState.Stopped,
      description:
        "Stopped → Executing: retry-limited event re-fired",
    },
    {
      from: EventState.Escalated,
      description:
        "Escalated → Executing: hard-declined event re-fired",
    },
    {
      from: EventState.Detected,
      description:
        "Detected → Executing: skip past every intermediate state",
    },
  ];

  it.each(terminalToExecuting)("$description", ({ from }) => {
    expect(() =>
      transition(from, EventState.Executing),
    ).toThrowError(IllegalTransitionError);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Self-transitions are always illegal
// ─────────────────────────────────────────────────────────────────────

describe("Self-transitions are illegal for every state", () => {
  it.each(ALL_STATES.map((s) => ({ state: s })))(
    "$state → $state should throw",
    ({ state }) => {
      expect(() => transition(state, state)).toThrowError(
        IllegalTransitionError,
      );
    },
  );
});

// ─────────────────────────────────────────────────────────────────────
// 5. Terminal-state properties
// ─────────────────────────────────────────────────────────────────────

const TERMINAL_STATES: EventState[] = [
  EventState.Parked_Control,
  EventState.Skipped,
  EventState.Succeeded,
  EventState.Stopped,
  EventState.Escalated,
];

const NON_TERMINAL_STATES: EventState[] = [
  EventState.Detected,
  EventState.Scored,
  EventState.Allocated,
  EventState.ActionSelected,
  EventState.PolicyRejected,
  EventState.PolicyApproved,
  EventState.Executing,
  EventState.Failed,
];

describe("isTerminal()", () => {
  it.each(TERMINAL_STATES.map((s) => ({ state: s })))(
    "$state is terminal",
    ({ state }) => {
      expect(isTerminal(state)).toBe(true);
    },
  );

  it.each(NON_TERMINAL_STATES.map((s) => ({ state: s })))(
    "$state is NOT terminal",
    ({ state }) => {
      expect(isTerminal(state)).toBe(false);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────
// 6. allowedTransitions() returns correct sets
// ─────────────────────────────────────────────────────────────────────

describe("allowedTransitions()", () => {
  it("Detected can only go to Scored", () => {
    const allowed = allowedTransitions(EventState.Detected);
    expect([...allowed]).toEqual([EventState.Scored]);
  });

  it("Scored can go to Parked_Control, Skipped, or Allocated", () => {
    const allowed = allowedTransitions(EventState.Scored);
    expect(allowed.size).toBe(3);
    expect(allowed.has(EventState.Parked_Control)).toBe(true);
    expect(allowed.has(EventState.Skipped)).toBe(true);
    expect(allowed.has(EventState.Allocated)).toBe(true);
  });

  it("Failed can go to Executing, Stopped, or Escalated", () => {
    const allowed = allowedTransitions(EventState.Failed);
    expect(allowed.size).toBe(3);
    expect(allowed.has(EventState.Executing)).toBe(true);
    expect(allowed.has(EventState.Stopped)).toBe(true);
    expect(allowed.has(EventState.Escalated)).toBe(true);
  });

  it("terminal states return empty sets", () => {
    for (const state of TERMINAL_STATES) {
      expect(allowedTransitions(state).size).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. IllegalTransitionError carries structured data
// ─────────────────────────────────────────────────────────────────────

describe("IllegalTransitionError", () => {
  it("includes from/to on the error object", () => {
    try {
      transition(EventState.Succeeded, EventState.Executing);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalTransitionError);
      const err = e as IllegalTransitionError;
      expect(err.from).toBe(EventState.Succeeded);
      expect(err.to).toBe(EventState.Executing);
      expect(err.message).toContain("Succeeded");
      expect(err.message).toContain("Executing");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. Exhaustive: every state has been mentioned in at least one test
// ─────────────────────────────────────────────────────────────────────

describe("ALL_STATES enumeration completeness", () => {
  it("has exactly 13 states", () => {
    expect(ALL_STATES.length).toBe(13);
  });

  it("matches the expected set", () => {
    const expected = new Set([
      "Detected",
      "Scored",
      "Parked_Control",
      "Skipped",
      "Allocated",
      "ActionSelected",
      "PolicyRejected",
      "PolicyApproved",
      "Executing",
      "Succeeded",
      "Failed",
      "Stopped",
      "Escalated",
    ]);
    expect(new Set(ALL_STATES)).toEqual(expected);
  });
});
