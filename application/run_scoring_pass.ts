/**
 * Application: runScoringPass
 *
 * Orchestration-only — no business logic.
 * Fetches all unscored risk events, extracts a feature vector from each,
 * runs the pure `score()` function from domain/scoring.ts, persists the
 * Score row, assigns the holdout group (~10% → control, rest → treatment),
 * and transitions the state machine Detected → Scored.
 *
 * Feature extraction:  We build a numeric feature vector from the RiskEvent
 * fields.  The feature_order in the Coefficients object tells the model
 * which position maps to which feature name — the runtime code just indexes
 * by position.  For pre-Task-18 operation (no trained model yet), a default
 * set of coefficients is accepted.
 */

import type { EventRepository } from "../ports/event_repository.js";
import type { RiskEvent, RiskGroup } from "../ports/types.js";
import { score, type Coefficients, type ScoreOutput } from "../domain/scoring.js";
import { transition, EventState } from "../domain/state_machine.js";

// ── Feature extraction ─────────────────────────────────────────────

/**
 * Map from feature name → extraction function.
 * Feature names match the synthetic data generator's feature columns
 * (Task 3.5) and will match the trained model's feature_order (Task 18).
 */
const FEATURE_EXTRACTORS: Record<string, (event: RiskEvent) => number> = {
  amount_inr: (e) => e.amount,
  is_retryable: (e) => {
    // Retryable decline codes — simplified mapping from raw_reason
    const retryable = [
      "card_declined",
      "insufficient_funds",
      "issuer_unavailable",
      "network_error",
      "timeout",
    ];
    return retryable.includes(e.raw_reason ?? "") ? 1 : 0;
  },
  is_payment_failure: (e) => (e.source_type === "payment_failure" ? 1 : 0),
  is_checkout_abandon: (e) => (e.source_type === "checkout_abandon" ? 1 : 0),
};

/**
 * Extract a positionally-ordered feature vector from a RiskEvent,
 * aligned with the coefficient's feature_order.
 *
 * If a feature name in feature_order has no extractor, it defaults to 0.
 */
export function extractFeatures(
  event: RiskEvent,
  featureOrder: readonly string[],
): number[] {
  return featureOrder.map((name) => {
    const extractor = FEATURE_EXTRACTORS[name];
    return extractor ? extractor(event) : 0;
  });
}

// ── Default coefficients (pre-Task 18) ─────────────────────────────

/**
 * Sensible defaults that produce reasonable score spreads.
 * These will be replaced by ml/coefficients.json after Task 18.
 */
export const DEFAULT_COEFFICIENTS: Coefficients = {
  intercept: -0.5,
  weights: [0.0001, 0.8, 0.3, -0.2],
  feature_order: [
    "amount_inr",
    "is_retryable",
    "is_payment_failure",
    "is_checkout_abandon",
  ],
};

// ── Holdout split ──────────────────────────────────────────────────

/**
 * Simple deterministic holdout: hash the event ID and assign ~10%
 * to control.  Using a numeric hash of the UUID is reproducible
 * and doesn't require external randomness.
 */
export function assignGroup(eventId: string, controlRate: number = 0.1): RiskGroup {
  // Sum the char codes of the UUID as a simple hash
  let hash = 0;
  for (let i = 0; i < eventId.length; i++) {
    hash = ((hash << 5) - hash + eventId.charCodeAt(i)) | 0;
  }
  // Map to [0, 1) range
  const fraction = Math.abs(hash) / 2147483647;
  return fraction < controlRate ? "control" : "treatment";
}

// ── Cost estimation ────────────────────────────────────────────────

/**
 * Estimate the cost of taking action on this event.
 * In production this would come from a cost model or config;
 * for now we use a simple heuristic based on amount.
 */
export function estimateCost(event: RiskEvent): number {
  // Fixed processing cost + percentage of amount
  return 10 + event.amount * 0.01;
}

// ── Scoring pass result ────────────────────────────────────────────

export interface ScoringPassResult {
  readonly scored: number;
  readonly control: number;
  readonly treatment: number;
}

// ── Use case ───────────────────────────────────────────────────────

/**
 * Run a scoring pass over all unscored events.
 *
 * For each event:
 *   1. Extract features
 *   2. Run score() with the provided coefficients
 *   3. Insert the Score row
 *   4. Assign holdout group (control/treatment)
 *   5. Transition state: Detected → Scored
 *   6. Write an audit log entry
 *
 * @param repo          EventRepository port
 * @param coefficients  Model coefficients (or defaults)
 * @param controlRate   Fraction of events to assign to control (default 0.1)
 */
export async function runScoringPass(
  repo: EventRepository,
  coefficients: Coefficients = DEFAULT_COEFFICIENTS,
  controlRate: number = 0.1,
): Promise<ScoringPassResult> {
  const unscoredEvents = await repo.findUnscoredEvents();

  let control = 0;
  let treatment = 0;

  for (const event of unscoredEvents) {
    // 1. Extract features
    const features = extractFeatures(event, coefficients.feature_order);

    // 2. Score
    const scoreOutput: ScoreOutput = score(coefficients, {
      features,
      amount: event.amount,
    });

    // 3. Estimate cost
    const costEstimate = estimateCost(event);

    // 4. Insert score row
    await repo.insertScore({
      event_id: event.id,
      p_loss: scoreOutput.p_loss,
      p_uplift: scoreOutput.p_uplift,
      expected_value: scoreOutput.expected_value,
      cost_estimate: costEstimate,
    });

    // 5. Assign holdout group
    const group = assignGroup(event.id, controlRate);
    await repo.setGroup(event.id, group);

    if (group === "control") {
      control++;
    } else {
      treatment++;
    }

    // 6. Audit log with scoring detail
    await repo.insertAuditLog({
      event_id: event.id,
      stage: "scoring_detail",
      detail: {
        p_loss: scoreOutput.p_loss,
        p_uplift: scoreOutput.p_uplift,
        expected_value: scoreOutput.expected_value,
        cost_estimate: costEstimate,
        group,
      },
    });

    // 7. Transition state: Detected → Scored
    //    We know the state is Detected because findUnscoredEvents only
    //    returns events without a Score row.
    const newState = transition(EventState.Detected, EventState.Scored);
    await repo.updateState(event.id, newState);
  }

  return {
    scored: unscoredEvents.length,
    control,
    treatment,
  };
}
