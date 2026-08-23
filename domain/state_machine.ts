/**
 * RecoveryOps event state machine.
 *
 * Implements the transition diagram from ARCHITECTURE.md exactly:
 *
 *   Detected
 *     → Scored
 *       → Parked_Control | Skipped | Allocated
 *         Allocated → ActionSelected
 *           → PolicyRejected → Escalated
 *           → PolicyApproved → Executing
 *             → Succeeded
 *             → Failed → Executing (retry) | Stopped | Escalated
 *
 * Any transition not in the table above is illegal and throws.
 */

// ── States ─────────────────────────────────────────────────────────

export const EventState = {
  Detected: "Detected",
  Scored: "Scored",
  Parked_Control: "Parked_Control",
  Skipped: "Skipped",
  Allocated: "Allocated",
  ActionSelected: "ActionSelected",
  PolicyRejected: "PolicyRejected",
  PolicyApproved: "PolicyApproved",
  Executing: "Executing",
  Succeeded: "Succeeded",
  Failed: "Failed",
  Stopped: "Stopped",
  Escalated: "Escalated",
} as const;

export type EventState = (typeof EventState)[keyof typeof EventState];

// ── Legal transition table ─────────────────────────────────────────

/**
 * Map from each state to the set of states it may transition to.
 * If a state is not a key here it is terminal (no outgoing edges).
 */
const LEGAL_TRANSITIONS: ReadonlyMap<EventState, ReadonlySet<EventState>> =
  new Map<EventState, ReadonlySet<EventState>>([
    [EventState.Detected, new Set([EventState.Scored])],
    [
      EventState.Scored,
      new Set([
        EventState.Parked_Control,
        EventState.Skipped,
        EventState.Allocated,
      ]),
    ],
    [EventState.Allocated, new Set([EventState.ActionSelected])],
    [
      EventState.ActionSelected,
      new Set([EventState.PolicyRejected, EventState.PolicyApproved]),
    ],
    [EventState.PolicyRejected, new Set([EventState.Escalated])],
    [EventState.PolicyApproved, new Set([EventState.Executing])],
    [
      EventState.Executing,
      new Set([EventState.Succeeded, EventState.Failed]),
    ],
    [
      EventState.Failed,
      new Set([EventState.Executing, EventState.Stopped, EventState.Escalated]),
    ],
    // Parked_Control — terminal
    // Skipped        — terminal
    // Succeeded      — terminal
    // Stopped        — terminal
    // Escalated      — terminal
  ]);

// ── Error ──────────────────────────────────────────────────────────

export class IllegalTransitionError extends Error {
  public readonly from: EventState;
  public readonly to: EventState;

  constructor(from: EventState, to: EventState) {
    super(`Illegal state transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Validates and performs a state transition.
 *
 * @param current  The current state of the event.
 * @param next     The desired next state.
 * @returns        The new state (always equal to `next` on success).
 * @throws {IllegalTransitionError} if the transition is not legal.
 */
export function transition(current: EventState, next: EventState): EventState {
  const allowed = LEGAL_TRANSITIONS.get(current);
  if (!allowed || !allowed.has(next)) {
    throw new IllegalTransitionError(current, next);
  }
  return next;
}

/**
 * Returns true if `state` is terminal (no outgoing transitions).
 */
export function isTerminal(state: EventState): boolean {
  return !LEGAL_TRANSITIONS.has(state);
}

/**
 * Returns the set of states reachable from `state` in one step,
 * or an empty set if the state is terminal.
 */
export function allowedTransitions(state: EventState): ReadonlySet<EventState> {
  return LEGAL_TRANSITIONS.get(state) ?? new Set();
}

/**
 * All possible event states as an array, useful for exhaustive tests.
 */
export const ALL_STATES: readonly EventState[] = Object.values(EventState);
