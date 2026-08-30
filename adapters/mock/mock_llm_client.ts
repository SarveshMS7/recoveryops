/**
 * Mock adapter: MockLlmClient
 *
 * Deterministic fake implementing the LlmClient port.
 * By default returns "retry_now" for payment_failure events and
 * "send_reminder" for others. Supports overriding responses per event
 * and failure injection.
 */

import type {
  LlmClient,
  LlmAnalysisRequest,
  LlmAnalysisResponse,
} from "../../ports/llm_client.js";
import type { SelectedAction } from "../../ports/types.js";
import { VALID_ACTIONS } from "../../ports/types.js";

export class MockLlmClient implements LlmClient {
  /** Log of all analysis requests, for test assertions. */
  readonly calls: LlmAnalysisRequest[] = [];

  // ── Response overrides ───────────────────────────────────────────
  private readonly overrides = new Map<string, LlmAnalysisResponse>();

  /**
   * Override the response for a specific event ID.
   * Set `action` to a value outside the enum to test validation.
   */
  setResponseFor(
    eventId: string,
    response: LlmAnalysisResponse,
  ): void {
    this.overrides.set(eventId, response);
  }

  // ── Failure injection ────────────────────────────────────────────
  private readonly failureMap = new Map<string, number>();

  forceFailureFor(eventId: string, times: number): void {
    this.failureMap.set(eventId, times);
  }

  private consumeFailure(eventId: string): boolean {
    const remaining = this.failureMap.get(eventId);
    if (remaining !== undefined && remaining > 0) {
      this.failureMap.set(eventId, remaining - 1);
      return true;
    }
    return false;
  }

  /** Reset all state. */
  reset(): void {
    this.calls.length = 0;
    this.overrides.clear();
    this.failureMap.clear();
  }

  // ── Port implementation ──────────────────────────────────────────

  async analyse(request: LlmAnalysisRequest): Promise<LlmAnalysisResponse> {
    this.calls.push(request);

    if (this.consumeFailure(request.event_id)) {
      throw new Error("MockLlmClient: injected failure");
    }

    // Check for per-event override
    const override = this.overrides.get(request.event_id);
    if (override) {
      // Return the override as-is — validation is the application layer's
      // responsibility (AGENTS.md hard rule #2).  This allows tests to
      // inject invalid actions and verify they are caught upstream.
      return override;
    }

    // Default deterministic response based on source type
    const action: SelectedAction =
      request.source_type === "payment_failure" ? "retry_now" : "send_reminder";

    return {
      root_cause_summary: `Mock root cause for ${request.source_type}: ${request.raw_reason ?? "unknown"}`,
      selected_action: action,
      rationale: `Mock rationale: ${action} is the default action for ${request.source_type} events`,
    };
  }

  /**
   * Validates that an action is a member of the SelectedAction enum.
   * @throws if the action is not in the closed enum.
   */
  private validateAction(action: string): asserts action is SelectedAction {
    if (!VALID_ACTIONS.includes(action as SelectedAction)) {
      throw new Error(
        `MockLlmClient: action "${action}" is not in the closed enum [${VALID_ACTIONS.join(", ")}]`,
      );
    }
  }
}
