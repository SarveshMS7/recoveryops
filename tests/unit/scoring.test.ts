/**
 * Tests for the RecoveryOps scoring function (Task 6).
 *
 * Coverage requirements (from TASKS.md):
 *   • Known coefficients + known input → exact expected output
 *   • Output computed independently (by hand) and hardcoded
 *
 * Hand computation (verified in a spreadsheet):
 *
 *   coefficients:
 *     intercept = 0.5
 *     weights   = [0.3, -0.2, 0.8]
 *
 *   input:
 *     features = [1.0, 2.0, 0.5]
 *     amount   = 5000
 *
 *   dot = 0.3*1.0 + (-0.2)*2.0 + 0.8*0.5 = 0.3 - 0.4 + 0.4 = 0.3
 *   logit = 0.5 + 0.3 = 0.8
 *
 *   p_loss   = sigmoid(0.8) = 1/(1+exp(-0.8))
 *            = 1/(1 + 0.449329...) = 1/1.449329... = 0.689974...
 *
 *   p_uplift = sigmoid(0.8 - 1) = sigmoid(-0.2) = 1/(1+exp(0.2))
 *            = 1/(1 + 1.221403...) = 1/2.221403... = 0.450166...
 *
 *   expected_value = 5000 * 0.689974... * 0.450166... = 1553.015...
 *
 * Zero I/O — pure function tests.
 */

import { describe, it, expect } from "vitest";
import {
  score,
  sigmoid,
  dotProduct,
  type Coefficients,
  type ScoreInput,
} from "../../domain/scoring.js";

// ── Known coefficients & input ─────────────────────────────────────

const KNOWN_COEFFICIENTS: Coefficients = {
  intercept: 0.5,
  weights: [0.3, -0.2, 0.8],
  feature_order: ["feature_a", "feature_b", "feature_c"],
};

const KNOWN_INPUT: ScoreInput = {
  features: [1.0, 2.0, 0.5],
  amount: 5000,
};

// Pre-computed golden values (by hand — see header comment)
const GOLDEN_LOGIT = 0.8;
const GOLDEN_P_LOSS = 1 / (1 + Math.exp(-0.8));            // 0.68997448...
const GOLDEN_P_UPLIFT = 1 / (1 + Math.exp(0.2));           // 0.45016600...
const GOLDEN_EV = 5000 * GOLDEN_P_LOSS * GOLDEN_P_UPLIFT;  // 1553.076...

// ═══════════════════════════════════════════════════════════════════
// 1. sigmoid()
// ═══════════════════════════════════════════════════════════════════

describe("Scoring: sigmoid", () => {
  it("sigmoid(0) = 0.5", () => {
    expect(sigmoid(0)).toBe(0.5);
  });

  it("sigmoid(large positive) ≈ 1", () => {
    expect(sigmoid(100)).toBeCloseTo(1.0, 10);
  });

  it("sigmoid(large negative) ≈ 0", () => {
    expect(sigmoid(-100)).toBeCloseTo(0.0, 10);
  });

  it("sigmoid(0.8) matches hand-computed value", () => {
    expect(sigmoid(0.8)).toBeCloseTo(GOLDEN_P_LOSS, 10);
  });

  it("sigmoid(-0.2) matches hand-computed value", () => {
    expect(sigmoid(-0.2)).toBeCloseTo(GOLDEN_P_UPLIFT, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. dotProduct()
// ═══════════════════════════════════════════════════════════════════

describe("Scoring: dotProduct", () => {
  it("computes 0.3*1.0 + (-0.2)*2.0 + 0.8*0.5 = 0.3", () => {
    const result = dotProduct([0.3, -0.2, 0.8], [1.0, 2.0, 0.5]);
    expect(result).toBeCloseTo(0.3, 10);
  });

  it("throws on length mismatch", () => {
    expect(() => dotProduct([1, 2], [3])).toThrowError("length mismatch");
  });

  it("handles empty arrays (dot product = 0)", () => {
    expect(dotProduct([], [])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. score() — golden value test (THE critical assertion)
// ═══════════════════════════════════════════════════════════════════

describe("Scoring: score() with known coefficients and known input", () => {
  const result = score(KNOWN_COEFFICIENTS, KNOWN_INPUT);

  it("p_loss matches hand-computed sigmoid(0.8)", () => {
    expect(result.p_loss).toBeCloseTo(GOLDEN_P_LOSS, 10);
  });

  it("p_uplift matches hand-computed sigmoid(-0.2)", () => {
    expect(result.p_uplift).toBeCloseTo(GOLDEN_P_UPLIFT, 10);
  });

  it("expected_value matches hand-computed amount * p_loss * p_uplift", () => {
    expect(result.expected_value).toBeCloseTo(GOLDEN_EV, 8);
  });

  // Hardcoded numeric assertions (not derived from the code under test)
  it("p_loss ≈ 0.6899745 (hardcoded)", () => {
    expect(result.p_loss).toBeCloseTo(0.6899745, 6);
  });

  it("p_uplift ≈ 0.4501660 (hardcoded)", () => {
    expect(result.p_uplift).toBeCloseTo(0.4501660, 6);
  });

  it("expected_value ≈ 1553.015 (hardcoded)", () => {
    expect(result.expected_value).toBeCloseTo(1553.015, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Edge cases
// ═══════════════════════════════════════════════════════════════════

describe("Scoring: edge cases", () => {
  it("all-zero features → logit = intercept only", () => {
    const result = score(KNOWN_COEFFICIENTS, { features: [0, 0, 0], amount: 1000 });
    // logit = 0.5 + 0 = 0.5
    expect(result.p_loss).toBeCloseTo(sigmoid(0.5), 10);
    expect(result.p_uplift).toBeCloseTo(sigmoid(-0.5), 10);
  });

  it("zero amount → expected_value = 0", () => {
    const result = score(KNOWN_COEFFICIENTS, { features: [1, 2, 0.5], amount: 0 });
    expect(result.expected_value).toBe(0);
  });

  it("zero intercept and weights → p_loss = 0.5, p_uplift = sigmoid(-1)", () => {
    const zeroCoeffs: Coefficients = {
      intercept: 0,
      weights: [0, 0],
      feature_order: ["a", "b"],
    };
    const result = score(zeroCoeffs, { features: [100, 200], amount: 1000 });
    expect(result.p_loss).toBe(0.5);
    expect(result.p_uplift).toBeCloseTo(sigmoid(-1), 10);
  });

  it("throws when features length ≠ weights length", () => {
    expect(() =>
      score(KNOWN_COEFFICIENTS, { features: [1, 2], amount: 100 }),
    ).toThrowError("length mismatch");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Coefficients type conformance
// ═══════════════════════════════════════════════════════════════════

describe("Scoring: Coefficients type", () => {
  it("feature_order is for documentation only — runtime uses positional indexing", () => {
    // Same weights, different feature_order names → identical output
    const altCoeffs: Coefficients = {
      intercept: 0.5,
      weights: [0.3, -0.2, 0.8],
      feature_order: ["x", "y", "z"], // different names
    };
    const result = score(altCoeffs, KNOWN_INPUT);
    expect(result.p_loss).toBeCloseTo(GOLDEN_P_LOSS, 10);
  });
});
