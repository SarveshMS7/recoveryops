/**
 * Port: LlmClient
 *
 * Asks an LLM for a root-cause analysis + recommended action for a
 * risk event.  The output is **always** a value from the closed
 * `SelectedAction` enum — free-text actions are architecturally
 * forbidden (AGENTS.md hard rule #2).
 *
 * Adapters: adapters/llm/ (real — OpenAI / Anthropic with constrained
 * output), adapters/mock/ (deterministic fake).
 */

import { VALID_ACTIONS } from "./types.js";
import type { SelectedAction, SourceType } from "./types.js";

// ── Error for invalid LLM action ──────────────────────────────────

export class InvalidLlmActionError extends Error {
  public readonly action: string;

  constructor(action: string) {
    super(
      `LLM returned action "${action}" which is not in the closed enum [${VALID_ACTIONS.join(", ")}]. Rejected before reaching the policy engine.`,
    );
    this.name = "InvalidLlmActionError";
    this.action = action;
  }
}

// ── Request / Response ─────────────────────────────────────────────

export interface LlmAnalysisRequest {
  readonly event_id: string;
  readonly source_type: SourceType;
  readonly amount: number;
  readonly currency: string;
  readonly raw_reason: string | null;
  /** Prior retry attempts for this event. */
  readonly attempt_count: number;
  /** Any additional context the application layer wants to pass. */
  readonly context: Record<string, unknown>;
}

export interface LlmAnalysisResponse {
  /** Root cause identified by the LLM. */
  readonly root_cause_summary: string;
  /**
   * Recommended action — MUST be a value from the SelectedAction enum.
   * The adapter is responsible for constraining the LLM output and
   * rejecting anything outside the enum before returning.
   */
  readonly selected_action: SelectedAction;
  /** The LLM's rationale for choosing this action. */
  readonly rationale: string;
}

// ── Port interface ─────────────────────────────────────────────────

export interface LlmClient {
  /**
   * Analyse a risk event and return a root cause + action recommendation.
   *
   * @throws if the LLM returns an action outside the closed enum —
   *         the adapter must validate before returning.
   */
  analyse(request: LlmAnalysisRequest): Promise<LlmAnalysisResponse>;

  /** Log of all analysis requests, for test assertions. */
  readonly calls: LlmAnalysisRequest[];
  
  /** Override the response for a specific event ID. */
  setResponseFor(eventId: string, response: LlmAnalysisResponse): void;
  
  /** Configure the mock to return a failure for the next N calls. */
  forceFailureFor(eventId: string, times: number): void;
  
  /** Reset all state. */
  reset(): void;
}
