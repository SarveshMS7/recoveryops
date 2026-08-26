/**
 * RecoveryOps policy engine — pure function, no I/O.
 *
 * Evaluates four policy rules against an event context:
 *   1. retry_limit   — attempt_number ≤ max_attempts
 *   2. cooldown      — enough time has elapsed since last attempt
 *   3. spend_cap     — merchant's daily spend has not exceeded cap
 *   4. compliance_window — current time is within allowed hours (IST)
 *
 * Each rule returns {passed, reason}. The aggregate check returns
 * an array of individual results, and a top-level passed/reason.
 *
 * The config shape matches config/policy.schema.json exactly.
 * Config is injected as a plain object — YAML parsing happens
 * outside domain/ (hexagonal boundary).
 */

// ── Policy config types ────────────────────────────────────────────

export interface RetryLimitConfig {
  readonly max_attempts: number;
}

export interface CooldownConfig {
  readonly min_interval_seconds: number;
}

export interface SpendCapConfig {
  readonly daily_limit_inr: number;
}

export interface ComplianceWindowConfig {
  readonly start_hour: number; // 0-23, inclusive
  readonly end_hour: number;   // 0-23, exclusive
}

export interface PolicyConfig {
  readonly retry_limit: RetryLimitConfig;
  readonly cooldown: CooldownConfig;
  readonly spend_cap: SpendCapConfig;
  readonly compliance_window: ComplianceWindowConfig;
}

// ── Event context (the minimum the policy engine needs) ────────────

export interface PolicyEventContext {
  /** The current attempt number (1-based). */
  readonly attempt_number: number;

  /** Timestamp of the last execution attempt, or null if first attempt. */
  readonly last_attempt_at: Date | null;

  /** The amount (INR) of this action. */
  readonly action_cost_inr: number;

  /** Total spend (INR) for this merchant today, *before* this action. */
  readonly merchant_daily_spend_inr: number;

  /**
   * The current timestamp — injected so the function is pure/testable.
   * Used for cooldown and compliance window checks.
   */
  readonly now: Date;
}

// ── Result types ───────────────────────────────────────────────────

export type PolicyCheckName =
  | "retry_limit"
  | "cooldown"
  | "spend_cap"
  | "compliance_window";

export interface PolicyCheckResult {
  readonly check_name: PolicyCheckName;
  readonly passed: boolean;
  readonly reason: string;
}

export interface PolicyResult {
  readonly passed: boolean;
  readonly reason: string;
  readonly checks: readonly PolicyCheckResult[];
}

// ── Individual rule evaluators ─────────────────────────────────────

/**
 * Retry limit: attempt_number must be ≤ max_attempts.
 * At-limit passes; one over fails.
 */
export function checkRetryLimit(
  config: RetryLimitConfig,
  ctx: PolicyEventContext,
): PolicyCheckResult {
  const passed = ctx.attempt_number <= config.max_attempts;
  return {
    check_name: "retry_limit",
    passed,
    reason: passed
      ? `Attempt ${ctx.attempt_number} is within limit of ${config.max_attempts}`
      : `Attempt ${ctx.attempt_number} exceeds retry limit of ${config.max_attempts}`,
  };
}

/**
 * Cooldown: if there was a previous attempt, at least min_interval_seconds
 * must have elapsed.  Just-after-cooldown passes; just-before fails.
 * First attempt (last_attempt_at === null) always passes.
 */
export function checkCooldown(
  config: CooldownConfig,
  ctx: PolicyEventContext,
): PolicyCheckResult {
  if (ctx.last_attempt_at === null) {
    return {
      check_name: "cooldown",
      passed: true,
      reason: "First attempt — no cooldown required",
    };
  }

  const elapsedMs = ctx.now.getTime() - ctx.last_attempt_at.getTime();
  const elapsedSeconds = elapsedMs / 1000;
  const required = config.min_interval_seconds;
  const passed = elapsedSeconds >= required;

  return {
    check_name: "cooldown",
    passed,
    reason: passed
      ? `${elapsedSeconds.toFixed(0)}s elapsed ≥ ${required}s cooldown`
      : `${elapsedSeconds.toFixed(0)}s elapsed < ${required}s cooldown — too soon`,
  };
}

/**
 * Spend cap: merchant_daily_spend_inr + action_cost_inr must be
 * ≤ daily_limit_inr.  Exactly-at-cap passes; one rupee over fails.
 */
export function checkSpendCap(
  config: SpendCapConfig,
  ctx: PolicyEventContext,
): PolicyCheckResult {
  const totalAfter = ctx.merchant_daily_spend_inr + ctx.action_cost_inr;
  const passed = totalAfter <= config.daily_limit_inr;

  return {
    check_name: "spend_cap",
    passed,
    reason: passed
      ? `Projected daily spend ₹${totalAfter} ≤ cap ₹${config.daily_limit_inr}`
      : `Projected daily spend ₹${totalAfter} exceeds cap ₹${config.daily_limit_inr}`,
  };
}

/**
 * Compliance window: the hour component of `now` (in IST) must be
 * ≥ start_hour and < end_hour.  Inside passes; outside fails.
 *
 * Note: we convert to IST (UTC+5:30) explicitly so the function
 * remains pure — it does not depend on the system timezone.
 */
export function checkComplianceWindow(
  config: ComplianceWindowConfig,
  ctx: PolicyEventContext,
): PolicyCheckResult {
  // IST = UTC + 5h 30m
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
  const istTime = new Date(ctx.now.getTime() + IST_OFFSET_MS);
  const hour = istTime.getUTCHours();

  const passed = hour >= config.start_hour && hour < config.end_hour;

  return {
    check_name: "compliance_window",
    passed,
    reason: passed
      ? `Current hour ${hour} IST is within window [${config.start_hour}, ${config.end_hour})`
      : `Current hour ${hour} IST is outside window [${config.start_hour}, ${config.end_hour})`,
  };
}

// ── Aggregate evaluator ────────────────────────────────────────────

/**
 * Runs all four policy checks.  The aggregate `passed` is true only
 * if every individual check passes.  The aggregate `reason` is the
 * reason of the first failing check, or a success message.
 */
export function evaluatePolicy(
  config: PolicyConfig,
  ctx: PolicyEventContext,
): PolicyResult {
  const checks: PolicyCheckResult[] = [
    checkRetryLimit(config.retry_limit, ctx),
    checkCooldown(config.cooldown, ctx),
    checkSpendCap(config.spend_cap, ctx),
    checkComplianceWindow(config.compliance_window, ctx),
  ];

  const firstFailure = checks.find((c) => !c.passed);

  return {
    passed: firstFailure === undefined,
    reason: firstFailure
      ? `Policy rejected: ${firstFailure.reason}`
      : "All policy checks passed",
    checks,
  };
}
