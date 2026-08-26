/**
 * Task 3.5 — Synthetic data generator for RecoveryOps.
 *
 * Produces 500 synthetic `payment_failure` and `checkout_abandon` events
 * matching the RiskEvent schema in ARCHITECTURE.md, with recovery-outcome
 * labels biased by features through a logistic model so downstream ML
 * (Task 18) has real signal to learn from.
 *
 * Run:  npx tsx ml/generate_synthetic_data.ts
 * Output: ml/synthetic_events.json  (the dataset)
 *         stdout sanity-check table  (manual rule vs majority baseline)
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──────────────────────────────────────────────────────────

type SourceType = "payment_failure" | "checkout_abandon";

interface SyntheticEvent {
  id: string;
  dedupe_key: string;
  merchant_id: string;
  source_type: SourceType;
  customer_id: string;
  amount: number;
  currency: "INR";
  raw_reason: string;
  detected_at: string;

  // Feature columns used for label generation & Task 18 training
  features: {
    amount_inr: number;
    days_overdue: number;              // payment_failure: 1–90; checkout_abandon: 0
    cart_stage: string;                // checkout_abandon: "address"|"payment"|"review"; payment_failure: "n/a"
    decline_category: "retryable" | "non_retryable";
    prior_retry_attempts: number;      // 0–5
    issuer_approval_rate: number;      // 0.0–1.0 (issuer history proxy)
    customer_success_rate: number;     // 0.0–1.0 (customer history proxy)
  };

  // Label — did this event eventually recover?
  recovered: boolean;
  // The raw probability used (for debugging / sanity-checking)
  recovery_probability: number;
}

// ── RNG helpers ────────────────────────────────────────────────────

/** Seedable splitmix32 PRNG for reproducibility. */
function splitmix32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x9e3779b9) | 0;
    let t = seed ^ (seed >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;   // [0, 1)
  };
}

const rng = splitmix32(42);

function randInt(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return rng() * (max - min) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// ── Logistic bias model ────────────────────────────────────────────
//
// recovery_probability = sigmoid(
//   intercept
//   + w_retryable   * is_retryable
//   + w_attempts    * prior_retry_attempts
//   + w_issuer      * issuer_approval_rate
//   + w_customer    * customer_success_rate
//   + w_amount      * log(amount)
//   + w_days        * days_overdue
//   + w_cart        * cart_closeness   (0 for payment_failure, 0/0.5/1 for abandon stage)
// )
//
// Weights are chosen so features clearly drive outcome.

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

const INTERCEPT = -0.5;
const W_RETRYABLE  =  1.8;   // retryable declines recover much more
const W_ATTEMPTS   = -0.6;   // more prior attempts → less likely to recover
const W_ISSUER     =  2.0;   // good issuer history → more likely
const W_CUSTOMER   =  1.5;   // good customer history → more likely
const W_AMOUNT     = -0.3;   // higher amounts slightly harder to recover
const W_DAYS       = -0.02;  // more days overdue → less likely
const W_CART       =  0.8;   // closer to purchase in cart → more recoverable

function cartCloseness(stage: string): number {
  switch (stage) {
    case "review":   return 1.0;
    case "payment":  return 0.5;
    case "address":  return 0.0;
    default:         return 0.0;  // payment_failure → n/a
  }
}

function computeRecoveryProbability(f: SyntheticEvent["features"]): number {
  const logit =
    INTERCEPT
    + W_RETRYABLE  * (f.decline_category === "retryable" ? 1 : 0)
    + W_ATTEMPTS   * f.prior_retry_attempts
    + W_ISSUER     * f.issuer_approval_rate
    + W_CUSTOMER   * f.customer_success_rate
    + W_AMOUNT     * Math.log(f.amount_inr / 1000 + 1)   // normalise amount
    + W_DAYS       * f.days_overdue
    + W_CART       * cartCloseness(f.cart_stage);
  return sigmoid(logit);
}

// ── Decline reason pools ───────────────────────────────────────────

const RETRYABLE_REASONS = [
  "insufficient_funds",
  "bank_timeout",
  "network_error",
  "issuer_unavailable",
  "temporary_hold",
] as const;

const NON_RETRYABLE_REASONS = [
  "stolen_card",
  "expired_card",
  "card_blocked",
  "fraud_suspected",
  "invalid_account",
] as const;

const CART_STAGES = ["address", "payment", "review"] as const;

// ── Generator ──────────────────────────────────────────────────────

const MERCHANT_ID = randomUUID();   // single synthetic merchant
const NUM_EVENTS = 500;

function generateEvent(index: number): SyntheticEvent {
  const id = randomUUID();
  const sourceType: SourceType = rng() < 0.6 ? "payment_failure" : "checkout_abandon";

  const isRetryable = rng() < 0.55;
  const declineCategory = isRetryable ? "retryable" as const : "non_retryable" as const;

  let rawReason: string;
  let daysOverdue: number;
  let cartStage: string;

  if (sourceType === "payment_failure") {
    rawReason = isRetryable ? pick(RETRYABLE_REASONS) : pick(NON_RETRYABLE_REASONS);
    daysOverdue = randInt(1, 90);
    cartStage = "n/a";
  } else {
    rawReason = `cart_abandoned_at_${pick(CART_STAGES)}`;
    daysOverdue = 0;
    cartStage = rawReason.replace("cart_abandoned_at_", "");
  }

  const amount = Math.round(randFloat(100, 50000) * 100) / 100;
  const priorRetryAttempts = randInt(0, 5);
  const issuerApprovalRate = Math.round(randFloat(0.3, 0.99) * 100) / 100;
  const customerSuccessRate = Math.round(randFloat(0.2, 0.98) * 100) / 100;

  const features: SyntheticEvent["features"] = {
    amount_inr: amount,
    days_overdue: daysOverdue,
    cart_stage: cartStage,
    decline_category: declineCategory,
    prior_retry_attempts: priorRetryAttempts,
    issuer_approval_rate: issuerApprovalRate,
    customer_success_rate: customerSuccessRate,
  };

  const p = computeRecoveryProbability(features);
  const recovered = rng() < p;

  // Detected timestamp: random time in the last 30 days
  const now = Date.now();
  const detectedAt = new Date(now - randInt(0, 30 * 24 * 60 * 60 * 1000));

  return {
    id,
    dedupe_key: `${sourceType}_${index}`,
    merchant_id: MERCHANT_ID,
    source_type: sourceType,
    customer_id: `cust_${randInt(1000, 9999)}`,
    amount,
    currency: "INR",
    raw_reason: rawReason,
    detected_at: detectedAt.toISOString(),
    features,
    recovered,
    recovery_probability: Math.round(p * 10000) / 10000,
  };
}

// ── Main ───────────────────────────────────────────────────────────

const events: SyntheticEvent[] = [];
for (let i = 0; i < NUM_EVENTS; i++) {
  events.push(generateEvent(i));
}

// Write dataset
const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "synthetic_events.json");
writeFileSync(outPath, JSON.stringify(events, null, 2), "utf-8");
console.log(`✅ Wrote ${events.length} events to ${outPath}\n`);

// ── Sanity check ───────────────────────────────────────────────────

const totalRecovered = events.filter((e) => e.recovered).length;
const totalNot = events.length - totalRecovered;
const majorityLabel = totalRecovered > totalNot;
const majorityCount = Math.max(totalRecovered, totalNot);
const majorityAccuracy = majorityCount / events.length;

console.log("═══════════════════════════════════════════════════════════");
console.log("  SANITY CHECK: Manual Rule vs Majority-Class Baseline");
console.log("═══════════════════════════════════════════════════════════\n");

console.log(`Dataset: ${events.length} events`);
console.log(`  Recovered:     ${totalRecovered} (${(totalRecovered / events.length * 100).toFixed(1)}%)`);
console.log(`  Not recovered: ${totalNot} (${(totalNot / events.length * 100).toFixed(1)}%)`);
console.log(`  Majority class: ${majorityLabel ? "recovered" : "not_recovered"}\n`);

// Majority-class baseline: always predict the majority label
const baselineCorrect = majorityCount;
console.log(`Baseline (always predict "${majorityLabel ? "recovered" : "not_recovered"}"):`);
console.log(`  Accuracy: ${baselineCorrect}/${events.length} = ${(majorityAccuracy * 100).toFixed(1)}%\n`);

// Manual rule using the features:
//   Predict "recovered" if:
//     decline_category === "retryable"
//     AND prior_retry_attempts <= 2
//     AND issuer_approval_rate >= 0.6
//     AND customer_success_rate >= 0.5
//   Otherwise predict "not_recovered"
function manualRule(e: SyntheticEvent): boolean {
  return (
    e.features.decline_category === "retryable" &&
    e.features.prior_retry_attempts <= 2 &&
    e.features.issuer_approval_rate >= 0.6 &&
    e.features.customer_success_rate >= 0.5
  );
}

let ruleCorrect = 0;
let tp = 0, fp = 0, fn = 0, tn = 0;
for (const e of events) {
  const predicted = manualRule(e);
  const actual = e.recovered;
  if (predicted && actual)    { tp++; ruleCorrect++; }
  if (predicted && !actual)   { fp++; }
  if (!predicted && actual)   { fn++; }
  if (!predicted && !actual)  { tn++; ruleCorrect++; }
}

const ruleAccuracy = ruleCorrect / events.length;
const precision = tp / (tp + fp || 1);
const recall = tp / (tp + fn || 1);

console.log("Manual rule (retryable + ≤2 attempts + issuer≥0.6 + customer≥0.5):");
console.log(`  Accuracy:  ${ruleCorrect}/${events.length} = ${(ruleAccuracy * 100).toFixed(1)}%`);
console.log(`  Precision: ${tp}/${tp + fp} = ${(precision * 100).toFixed(1)}%`);
console.log(`  Recall:    ${tp}/${tp + fn} = ${(recall * 100).toFixed(1)}%`);
console.log(`  Confusion: TP=${tp}  FP=${fp}  FN=${fn}  TN=${tn}\n`);

const lift = ruleAccuracy - majorityAccuracy;
console.log("─────────────────────────────────────────────────────────");
console.log(`  Lift over baseline: ${lift > 0 ? "+" : ""}${(lift * 100).toFixed(1)} percentage points`);
console.log(`  Manual rule ${lift > 0 ? "BEATS" : "DOES NOT BEAT"} majority-class baseline`);
console.log("─────────────────────────────────────────────────────────\n");

// Also show feature-vs-outcome correlations for extra confidence
console.log("Feature breakdown (recovery rates by subgroup):");

const groups: Record<string, { total: number; recovered: number }> = {};
function addToGroup(name: string, e: SyntheticEvent) {
  if (!groups[name]) groups[name] = { total: 0, recovered: 0 };
  groups[name]!.total++;
  if (e.recovered) groups[name]!.recovered++;
}

for (const e of events) {
  addToGroup(`decline=${e.features.decline_category}`, e);
  addToGroup(`attempts=${e.features.prior_retry_attempts <= 1 ? "0-1" : "2+"}`, e);
  addToGroup(`issuer_rate=${e.features.issuer_approval_rate >= 0.7 ? "high(≥0.7)" : "low(<0.7)"}`, e);
  addToGroup(`customer_rate=${e.features.customer_success_rate >= 0.6 ? "high(≥0.6)" : "low(<0.6)"}`, e);
  addToGroup(`source=${e.features.cart_stage !== "n/a" ? "checkout_abandon" : "payment_failure"}`, e);
}

for (const [name, g] of Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))) {
  const rate = (g.recovered / g.total * 100).toFixed(1);
  console.log(`  ${name.padEnd(40)} ${g.recovered}/${g.total} = ${rate}%`);
}

console.log("\n✅ Sanity check complete.\n");
