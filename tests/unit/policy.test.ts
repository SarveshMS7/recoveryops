/**
 * Boundary tests for the RecoveryOps policy engine (Task 4).
 *
 * Coverage requirements (from TASKS.md):
 *   • retry_limit:       exactly-at-limit vs one-over
 *   • cooldown:          just-before vs just-after cooldown elapsed
 *   • spend_cap:         exactly-at-cap vs one-rupee-over
 *   • compliance_window: inside vs outside the window
 *
 * Zero I/O — all time/state is injected.
 */

import { describe, it, expect } from "vitest";
import {
  checkRetryLimit,
  checkCooldown,
  checkSpendCap,
  checkComplianceWindow,
  evaluatePolicy,
  type PolicyConfig,
  type PolicyEventContext,
} from "../../domain/policy.js";

// ── Shared config used across tests ────────────────────────────────

const CONFIG: PolicyConfig = {
  retry_limit: { max_attempts: 3 },
  cooldown: { min_interval_seconds: 3600 },        // 1 hour
  spend_cap: { daily_limit_inr: 100_000 },          // ₹1,00,000
  compliance_window: { start_hour: 8, end_hour: 21 }, // 08:00–21:00 IST
};

// Helper: build a UTC Date that corresponds to a given IST hour.
// IST = UTC + 5:30, so UTC hour = IST hour - 5, UTC minute = 30 subtracted.
// We pick an arbitrary date (2025-06-15) to avoid DST issues (India has none).
function utcDateForIstHour(istHour: number, istMinute = 0): Date {
  // Convert IST to UTC: subtract 5h 30m
  let utcHour = istHour - 5;
  let utcMinute = istMinute - 30;
  let day = 15;
  if (utcMinute < 0) {
    utcMinute += 60;
    utcHour -= 1;
  }
  if (utcHour < 0) {
    utcHour += 24;
    day -= 1;
  }
  return new Date(Date.UTC(2025, 5, day, utcHour, utcMinute, 0, 0));
}

/** Base context — all checks pass with default config. */
function baseCtx(overrides: Partial<PolicyEventContext> = {}): PolicyEventContext {
  return {
    attempt_number: 1,
    last_attempt_at: null,
    action_cost_inr: 1000,
    merchant_daily_spend_inr: 0,
    now: utcDateForIstHour(10), // 10:00 IST — inside window
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. RETRY LIMIT — exactly-at-limit vs one-over
// ═══════════════════════════════════════════════════════════════════

describe("Policy: retry_limit", () => {
  it("passes when attempt_number < max_attempts", () => {
    const result = checkRetryLimit(CONFIG.retry_limit, baseCtx({ attempt_number: 1 }));
    expect(result.passed).toBe(true);
    expect(result.check_name).toBe("retry_limit");
  });

  it("passes when attempt_number === max_attempts (exactly at limit)", () => {
    const result = checkRetryLimit(CONFIG.retry_limit, baseCtx({ attempt_number: 3 }));
    expect(result.passed).toBe(true);
  });

  it("fails when attempt_number === max_attempts + 1 (one over)", () => {
    const result = checkRetryLimit(CONFIG.retry_limit, baseCtx({ attempt_number: 4 }));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("exceeds");
  });

  it("fails when attempt_number is well over the limit", () => {
    const result = checkRetryLimit(CONFIG.retry_limit, baseCtx({ attempt_number: 10 }));
    expect(result.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. COOLDOWN — just-before vs just-after cooldown elapsed
// ═══════════════════════════════════════════════════════════════════

describe("Policy: cooldown", () => {
  const now = new Date("2025-06-15T10:00:00Z");

  it("passes on first attempt (no prior attempt)", () => {
    const result = checkCooldown(CONFIG.cooldown, baseCtx({
      last_attempt_at: null,
      now,
    }));
    expect(result.passed).toBe(true);
    expect(result.reason).toContain("First attempt");
  });

  it("passes when elapsed === min_interval_seconds (just after)", () => {
    // Last attempt was exactly 3600 seconds ago
    const lastAttempt = new Date(now.getTime() - 3600 * 1000);
    const result = checkCooldown(CONFIG.cooldown, baseCtx({
      last_attempt_at: lastAttempt,
      now,
    }));
    expect(result.passed).toBe(true);
  });

  it("passes when elapsed > min_interval_seconds (well after)", () => {
    const lastAttempt = new Date(now.getTime() - 7200 * 1000); // 2 hours ago
    const result = checkCooldown(CONFIG.cooldown, baseCtx({
      last_attempt_at: lastAttempt,
      now,
    }));
    expect(result.passed).toBe(true);
  });

  it("fails when elapsed === min_interval_seconds - 1 (just before, one second short)", () => {
    // Last attempt was 3599 seconds ago
    const lastAttempt = new Date(now.getTime() - 3599 * 1000);
    const result = checkCooldown(CONFIG.cooldown, baseCtx({
      last_attempt_at: lastAttempt,
      now,
    }));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("too soon");
  });

  it("fails when elapsed is very short (10 seconds)", () => {
    const lastAttempt = new Date(now.getTime() - 10 * 1000);
    const result = checkCooldown(CONFIG.cooldown, baseCtx({
      last_attempt_at: lastAttempt,
      now,
    }));
    expect(result.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. SPEND CAP — exactly-at-cap vs one-rupee-over
// ═══════════════════════════════════════════════════════════════════

describe("Policy: spend_cap", () => {
  it("passes when projected spend < daily_limit_inr", () => {
    const result = checkSpendCap(CONFIG.spend_cap, baseCtx({
      merchant_daily_spend_inr: 50_000,
      action_cost_inr: 10_000,
    }));
    expect(result.passed).toBe(true);
  });

  it("passes when projected spend === daily_limit_inr (exactly at cap)", () => {
    // 99,000 already spent + 1,000 action = 100,000 = cap
    const result = checkSpendCap(CONFIG.spend_cap, baseCtx({
      merchant_daily_spend_inr: 99_000,
      action_cost_inr: 1_000,
    }));
    expect(result.passed).toBe(true);
  });

  it("fails when projected spend === daily_limit_inr + 1 (one rupee over)", () => {
    // 99,001 already spent + 1,000 action = 100,001 > cap
    const result = checkSpendCap(CONFIG.spend_cap, baseCtx({
      merchant_daily_spend_inr: 99_001,
      action_cost_inr: 1_000,
    }));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("exceeds");
  });

  it("fails when already at cap (zero-cost action still ok, but over is not)", () => {
    // 100,000 already spent + 1 action = 100,001
    const result = checkSpendCap(CONFIG.spend_cap, baseCtx({
      merchant_daily_spend_inr: 100_000,
      action_cost_inr: 1,
    }));
    expect(result.passed).toBe(false);
  });

  it("passes when already at cap with zero-cost action", () => {
    // 100,000 already spent + 0 action = exactly at cap
    const result = checkSpendCap(CONFIG.spend_cap, baseCtx({
      merchant_daily_spend_inr: 100_000,
      action_cost_inr: 0,
    }));
    expect(result.passed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. COMPLIANCE WINDOW — inside vs outside
// ═══════════════════════════════════════════════════════════════════

describe("Policy: compliance_window", () => {
  it("passes when hour is inside the window (10 IST)", () => {
    const result = checkComplianceWindow(CONFIG.compliance_window, baseCtx({
      now: utcDateForIstHour(10),
    }));
    expect(result.passed).toBe(true);
  });

  it("passes at start_hour boundary (08:00 IST — inclusive)", () => {
    const result = checkComplianceWindow(CONFIG.compliance_window, baseCtx({
      now: utcDateForIstHour(8, 0),
    }));
    expect(result.passed).toBe(true);
  });

  it("passes just before end_hour (20:59 IST)", () => {
    const result = checkComplianceWindow(CONFIG.compliance_window, baseCtx({
      now: utcDateForIstHour(20, 59),
    }));
    expect(result.passed).toBe(true);
  });

  it("fails at end_hour boundary (21:00 IST — exclusive)", () => {
    const result = checkComplianceWindow(CONFIG.compliance_window, baseCtx({
      now: utcDateForIstHour(21, 0),
    }));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("outside");
  });

  it("fails just before start_hour (07:59 IST)", () => {
    const result = checkComplianceWindow(CONFIG.compliance_window, baseCtx({
      now: utcDateForIstHour(7, 59),
    }));
    expect(result.passed).toBe(false);
  });

  it("fails at midnight IST (00:00)", () => {
    const result = checkComplianceWindow(CONFIG.compliance_window, baseCtx({
      now: utcDateForIstHour(0, 0),
    }));
    expect(result.passed).toBe(false);
  });

  it("fails late at night IST (23:00)", () => {
    const result = checkComplianceWindow(CONFIG.compliance_window, baseCtx({
      now: utcDateForIstHour(23, 0),
    }));
    expect(result.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. AGGREGATE — evaluatePolicy()
// ═══════════════════════════════════════════════════════════════════

describe("Policy: evaluatePolicy (aggregate)", () => {
  it("passes when all checks pass", () => {
    const ctx = baseCtx(); // defaults all pass
    const result = evaluatePolicy(CONFIG, ctx);
    expect(result.passed).toBe(true);
    expect(result.reason).toBe("All policy checks passed");
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("fails when only retry_limit fails", () => {
    const ctx = baseCtx({ attempt_number: 4 });
    const result = evaluatePolicy(CONFIG, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("retry limit");
    // Other checks still ran
    expect(result.checks).toHaveLength(4);
  });

  it("fails when only cooldown fails", () => {
    const now = new Date("2025-06-15T10:00:00Z");
    const ctx = baseCtx({
      last_attempt_at: new Date(now.getTime() - 1000), // 1s ago
      now,
    });
    const result = evaluatePolicy(CONFIG, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("cooldown");
  });

  it("fails when only spend_cap fails", () => {
    const ctx = baseCtx({
      merchant_daily_spend_inr: 100_000,
      action_cost_inr: 1,
    });
    const result = evaluatePolicy(CONFIG, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("exceeds cap");
  });

  it("fails when only compliance_window fails", () => {
    const ctx = baseCtx({ now: utcDateForIstHour(23) });
    const result = evaluatePolicy(CONFIG, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("outside window");
  });

  it("reports first failing check when multiple fail", () => {
    const ctx = baseCtx({
      attempt_number: 10,
      now: utcDateForIstHour(2), // also outside window
    });
    const result = evaluatePolicy(CONFIG, ctx);
    expect(result.passed).toBe(false);
    // retry_limit is checked first, so its reason should appear
    expect(result.reason).toContain("retry limit");
  });

  it("returns all four check names", () => {
    const result = evaluatePolicy(CONFIG, baseCtx());
    const names = result.checks.map((c) => c.check_name);
    expect(names).toEqual([
      "retry_limit",
      "cooldown",
      "spend_cap",
      "compliance_window",
    ]);
  });
});
