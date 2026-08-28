/**
 * RecoveryOps scoring function — pure, no I/O.
 *
 * Takes an event's feature vector (ordered array of numbers) and a
 * Coefficients object, returns p_loss, p_uplift, and expected_value
 * via dot-product + sigmoid.
 *
 * Coefficients are injected — never hardcoded.  The Coefficients shape
 * matches Task 18's scikit-learn output exactly.
 */

// ── Types ──────────────────────────────────────────────────────────

/**
 * Coefficients shape — matches Task 18's `ml/coefficients.json` exactly.
 * Do not deviate from this shape.
 */
export type Coefficients = {
  intercept: number;
  weights: number[];       // ordered array, same order as feature_order
  feature_order: string[]; // names, for documentation/debugging only —
                            // runtime code must index weights[] by position,
                            // never look up by name
};

export interface ScoreInput {
  /** Feature values, positionally aligned with Coefficients.weights[]. */
  readonly features: readonly number[];
  /** The monetary amount at risk (used to compute expected_value). */
  readonly amount: number;
}

export interface ScoreOutput {
  /** Probability of loss if no action is taken (sigmoid of dot-product). */
  readonly p_loss: number;
  /** Probability of recovery uplift from intervention (sigmoid of dot-product with offset). */
  readonly p_uplift: number;
  /** Expected value of intervening: amount * p_loss * p_uplift. */
  readonly expected_value: number;
}

// ── Core math ──────────────────────────────────────────────────────

/** Standard logistic sigmoid: 1 / (1 + exp(-x)). */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Dot-product of two equal-length arrays.
 * @throws if lengths differ.
 */
export function dotProduct(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `dotProduct: length mismatch — a has ${a.length} elements, b has ${b.length}`,
    );
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

// ── Scoring function ───────────────────────────────────────────────

/**
 * Computes p_loss, p_uplift, and expected_value for a single event.
 *
 * p_loss   = sigmoid(intercept + dot(weights, features))
 * p_uplift = sigmoid(intercept + dot(weights, features) - 1)
 *            (shifted down — uplift is harder than raw loss prediction)
 * expected_value = amount * p_loss * p_uplift
 *
 * @param coefficients  Model coefficients (from ml/coefficients.json).
 * @param input         Feature vector + amount.
 * @returns             Score output with p_loss, p_uplift, expected_value.
 * @throws              If features length ≠ weights length.
 */
export function score(
  coefficients: Coefficients,
  input: ScoreInput,
): ScoreOutput {
  const logit = coefficients.intercept + dotProduct(coefficients.weights, input.features);

  const p_loss = sigmoid(logit);
  // Uplift is modeled as a shifted sigmoid — the same features predict
  // recoverability, but with lower base rate than raw loss.
  const p_uplift = sigmoid(logit - 1);

  const expected_value = input.amount * p_loss * p_uplift;

  return { p_loss, p_uplift, expected_value };
}
