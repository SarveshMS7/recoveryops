/**
 * Application: executeDecision
 *
 * Orchestration-only — no business logic.
 * For an allocated event:
 *   1. Calls the LLM client for root cause + action recommendation
 *   2. Validates the LLM output against the closed SelectedAction enum
 *      (rejects BEFORE the policy engine — hard rule #2)
 *   3. Records the Decision
 *   4. Runs the policy engine (the final gate — hard rule #3)
 *   5. If policy rejects → PolicyRejected → Escalated
 *   6. If policy passes → PolicyApproved → Executing
 *   7. Calls the payment gateway with idempotency_key = event_id:attempt_number
 *   8. Records the ActionExecution (unique constraint on idempotency_key)
 *   9. Transitions to Succeeded or Failed based on gateway result
 *
 * Idempotency: the idempotency_key is event_id + attempt_number.
 * Calling executeDecision twice with the same event and attempt
 * produces exactly one action_execution row (DB unique constraint).
 */

import type { EventRepository } from "../ports/event_repository.js";
import type { LlmClient } from "../ports/llm_client.js";
import { InvalidLlmActionError } from "../ports/llm_client.js";

import type { PaymentGateway } from "../ports/payment_gateway.js";
import type { RiskEvent, SelectedAction } from "../ports/types.js";
import { VALID_ACTIONS } from "../ports/types.js";
import {
  evaluatePolicy,
  type PolicyConfig,
  type PolicyEventContext,
} from "../domain/policy.js";
import { transition, EventState, isTerminal } from "../domain/state_machine.js";


// ── Result types ──────────────────────────────────────────────────

export type ExecutionOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly detail: string | null }
  | { readonly status: "stopped"; readonly detail: string | null }
  | { readonly status: "policy_rejected"; readonly reason: string }
  | { readonly status: "invalid_action"; readonly action: string }
  | { readonly status: "idempotent_skip" }
  | { readonly status: "already_terminal"; readonly state: string };

// ── Use case ──────────────────────────────────────────────────────

/**
 * Execute a decision for an allocated event.
 *
 * @param repo            EventRepository port
 * @param llm             LlmClient port
 * @param gateway         PaymentGateway port
 * @param policyConfig    Policy configuration (from config/policy.yaml)
 * @param event           The risk event to process
 * @param attemptNumber   Current attempt number (1-based)
 */
export async function executeDecision(
  repo: EventRepository,
  llm: LlmClient,
  gateway: PaymentGateway,
  policyConfig: PolicyConfig,
  event: RiskEvent,
  attemptNumber: number,
): Promise<ExecutionOutcome> {
  const idempotencyKey = `${event.id}:${attemptNumber}`;

  const currentStateStr = await repo.getCurrentState(event.id);
  if (currentStateStr && isTerminal(currentStateStr as EventState)) {
    return {
      status: "already_terminal",
      state: currentStateStr,
    };
  }

  // ── Step 1: Call LLM for analysis ─────────────────────────────

  const priorExecutions = await repo.findActionExecutionsByEventId(event.id);
  const latestExecution = priorExecutions.length > 0
    ? priorExecutions[priorExecutions.length - 1]!
    : null;

  const llmResponse = await llm.analyse({
    event_id: event.id,
    source_type: event.source_type,
    amount: event.amount,
    currency: event.currency,
    raw_reason: event.raw_reason,
    attempt_count: priorExecutions.length,
    context: {
      merchant_id: event.merchant_id,
      customer_id: event.customer_id,
    },
  });

  // ── Step 2: Validate action against closed enum ───────────────
  //    AGENTS.md hard rule #2: LLM output must be from the closed enum.
  //    Validate BEFORE the policy engine.

  if (!VALID_ACTIONS.includes(llmResponse.selected_action as SelectedAction)) {
    await repo.insertAuditLog({
      event_id: event.id,
      stage: "llm_action_rejected",
      detail: {
        action: llmResponse.selected_action,
        reason: "Action is not in the closed enum",
      },
    });
    throw new InvalidLlmActionError(llmResponse.selected_action);
  }

  // ── Step 3: Record Decision ───────────────────────────────────

  await repo.insertDecision({
    event_id: event.id,
    root_cause_summary: llmResponse.root_cause_summary,
    selected_action: llmResponse.selected_action,
    rationale: llmResponse.rationale,
  });

  // Transition: Allocated → ActionSelected
  const newStateAS = transition(EventState.Allocated, EventState.ActionSelected);
  await repo.updateState(event.id, newStateAS);

  // ── Step 4: Run policy engine ─────────────────────────────────
  //    AGENTS.md hard rule #3: the policy engine is the final gate.

  const merchantDailySpend = await repo.getMerchantDailySpend(
    event.merchant_id,
    new Date(),
  );

  const policyCtx: PolicyEventContext = {
    attempt_number: attemptNumber,
    last_attempt_at: latestExecution?.executed_at ?? null,
    action_cost_inr: event.amount,
    merchant_daily_spend_inr: merchantDailySpend,
    now: new Date(),
  };

  const policyResult = evaluatePolicy(policyConfig, policyCtx);

  // Record all individual policy checks
  for (const check of policyResult.checks) {
    await repo.insertPolicyCheck({
      event_id: event.id,
      check_name: check.check_name,
      passed: check.passed,
      detail: check.reason,
    });
  }

  // ── Step 5/6: Handle policy result ────────────────────────────

  if (!policyResult.passed) {
    // Policy rejected → PolicyRejected → Escalated
    await repo.insertAuditLog({
      event_id: event.id,
      stage: "policy_rejected_detail",
      detail: {
        reason: policyResult.reason,
        checks: policyResult.checks,
      },
    });

    const stPR = transition(EventState.ActionSelected, EventState.PolicyRejected);
    await repo.updateState(event.id, stPR);

    const stEsc = transition(EventState.PolicyRejected, EventState.Escalated);
    await repo.updateState(event.id, stEsc);

    return { status: "policy_rejected", reason: policyResult.reason };
  }

  // Policy approved → PolicyApproved → Executing
  const stPA = transition(EventState.ActionSelected, EventState.PolicyApproved);
  await repo.updateState(event.id, stPA);

  const stExec = transition(EventState.PolicyApproved, EventState.Executing);
  await repo.updateState(event.id, stExec);

  // ── Step 7: Call payment gateway ──────────────────────────────

  const gatewayResponse = await gateway.executeAction({
    event_id: event.id,
    external_ref: event.dedupe_key,
    action: llmResponse.selected_action,
    amount: event.amount,
    currency: event.currency,
    idempotency_key: idempotencyKey,
  });

  // ── Step 8: Record ActionExecution ────────────────────────────
  //    Idempotency: unique constraint on idempotency_key.
  //    If a row with the same key already exists, returns null.

  const execResult = await repo.insertActionExecution({
    event_id: event.id,
    idempotency_key: idempotencyKey,
    action: llmResponse.selected_action,
    attempt_number: attemptNumber,
    result: gatewayResponse.result,
  });

  if (execResult === null) {
    // Idempotent duplicate — skip silently.
    return { status: "idempotent_skip" };
  }

  // ── Step 9: Transition based on result ────────────────────────

  if (gatewayResponse.result === "success") {
    await repo.insertAuditLog({
      event_id: event.id,
      stage: "execution_succeeded_detail",
      detail: {
        action: llmResponse.selected_action,
        attempt_number: attemptNumber,
        gateway_ref: gatewayResponse.gateway_ref,
      },
    });

    const stSucc = transition(EventState.Executing, EventState.Succeeded);
    await repo.updateState(event.id, stSucc);

    return { status: "succeeded" };
  } else {
    // Failed or timeout
    await repo.insertAuditLog({
      event_id: event.id,
      stage: "execution_failed_detail",
      detail: {
        action: llmResponse.selected_action,
        attempt_number: attemptNumber,
        result: gatewayResponse.result,
        detail: gatewayResponse.detail,
      },
    });

    const stFailed = transition(EventState.Executing, EventState.Failed);
    await repo.updateState(event.id, stFailed);

    if (attemptNumber >= policyConfig.retry_limit.max_attempts) {
      const stStopped = transition(EventState.Failed, EventState.Stopped);
      await repo.updateState(event.id, stStopped);
      return { status: "stopped", detail: gatewayResponse.detail };
    }

    return { status: "failed", detail: gatewayResponse.detail };
  }
}
