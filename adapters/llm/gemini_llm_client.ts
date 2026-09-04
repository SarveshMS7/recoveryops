/**
 * Real adapter: GeminiLlmClient
 *
 * Implements the LlmClient port against Google's Gemini API using
 * raw `fetch()` (zero extra npm dependencies).
 *
 * Key behaviour:
 *   1. Constructs a detailed prompt from the LlmAnalysisRequest.
 *   2. Uses Gemini's structured-output mode (responseMimeType = "application/json"
 *      + responseSchema) to constrain the output to the SelectedAction enum.
 *   3. Validates the parsed response against the closed enum (defence-in-depth).
 *   4. Returns a clean LlmAnalysisResponse.
 *
 * Credentials: reads GEMINI_API_KEY from env or from the constructor config.
 */

import type {
  LlmClient,
  LlmAnalysisRequest,
  LlmAnalysisResponse,
} from "../../ports/llm_client.js";
import { InvalidLlmActionError } from "../../ports/llm_client.js";
import { VALID_ACTIONS } from "../../ports/types.js";
import type { SelectedAction } from "../../ports/types.js";

// ── Configuration ─────────────────────────────────────────────────

export interface GeminiConfig {
  readonly api_key: string;
  /** Model name. Defaults to "gemini-3.6-flash". */
  readonly model?: string;
  /** Request timeout in ms. Defaults to 60 000. */
  readonly timeout_ms?: number;
}

// ── Gemini API types (minimal, inlined) ───────────────────────────

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
}

// ── Adapter ───────────────────────────────────────────────────────

const GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.6-flash";
const DEFAULT_TIMEOUT_MS = 60_000;

export class GeminiLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config?: GeminiConfig) {
    const key = config?.api_key ?? process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error(
        "GeminiLlmClient: GEMINI_API_KEY is required " +
          "(pass via constructor config or environment variable).",
      );
    }
    this.apiKey = key;
    this.model = config?.model ?? DEFAULT_MODEL;
    this.timeoutMs = config?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  // ── Observability & Controllability (Test Fakes) ───────────────

  readonly calls: LlmAnalysisRequest[] = [];
  private readonly overrides = new Map<string, LlmAnalysisResponse>();
  private readonly failureMap = new Map<string, number>();

  setResponseFor(eventId: string, response: LlmAnalysisResponse): void {
    this.overrides.set(eventId, response);
  }

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

  reset(): void {
    this.calls.length = 0;
    this.overrides.clear();
    this.failureMap.clear();
  }

  // ── Port implementation ────────────────────────────────────────

  async analyse(request: LlmAnalysisRequest): Promise<LlmAnalysisResponse> {
    this.calls.push(request);

    if (this.consumeFailure(request.event_id)) {
      throw new Error("GeminiLlmClient: injected failure");
    }

    const override = this.overrides.get(request.event_id);
    if (override) {
      // Validate override against enum, throw InvalidLlmActionError if invalid
      // (This simulates what the real API parsing does)
      if (!VALID_ACTIONS.includes(override.selected_action as SelectedAction)) {
        throw new InvalidLlmActionError(override.selected_action);
      }
      return override;
    }

    const prompt = this.buildPrompt(request);
    const raw = await this.callGemini(prompt);

    // Parse JSON from model output
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(
        `GeminiLlmClient: model returned unparseable JSON: ${raw.slice(0, 200)}`,
      );
    }

    // Defence-in-depth: validate action against closed enum even though
    // the schema constraint should have enforced it.
    const action = String(parsed.selected_action ?? "");
    if (!VALID_ACTIONS.includes(action as SelectedAction)) {
      throw new InvalidLlmActionError(action);
    }

    return {
      root_cause_summary: String(parsed.root_cause_summary ?? ""),
      selected_action: action as SelectedAction,
      rationale: String(parsed.rationale ?? ""),
    };
  }

  // ── Helpers ────────────────────────────────────────────────────

  private buildPrompt(request: LlmAnalysisRequest): string {
    const ctx = request.context as Record<string, unknown>;
    return [
      "You are a payment recovery analyst for a fintech company.",
      "Analyse the following failed payment event and recommend a recovery action.",
      "",
      "## Event Details",
      `- Event ID: ${request.event_id}`,
      `- Source Type: ${request.source_type}`,
      `- Amount: ${request.amount} ${request.currency}`,
      `- Raw Reason: ${request.raw_reason ?? "unknown"}`,
      `- Prior Attempts: ${request.attempt_count}`,
      `- Merchant ID: ${ctx.merchant_id ?? "unknown"}`,
      `- Customer ID: ${ctx.customer_id ?? "unknown"}`,
      "",
      "## Allowed Actions (pick EXACTLY ONE):",
      ...VALID_ACTIONS.map((a) => `- "${a}"`),
      "",
      "## Rules",
      "1. Identify the most likely root cause of the payment failure.",
      "2. Choose the single best recovery action from the allowed list above.",
      "3. Provide a brief rationale for your choice.",
      "",
      "Respond with a JSON object containing:",
      '- "root_cause_summary": concise root cause explanation',
      '- "selected_action": one of the allowed actions (exactly as listed)',
      '- "rationale": why you chose this action',
    ].join("\n");
  }

  /**
   * Call Gemini's generateContent endpoint with structured JSON output.
   * Returns the raw text from the model's first candidate.
   */
  private async callGemini(prompt: string): Promise<string> {
    const url =
      `${GEMINI_BASE}/${this.model}:generateContent?key=${this.apiKey}`;

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            root_cause_summary: {
              type: "STRING",
              description: "Root cause analysis of the payment failure",
            },
            selected_action: {
              type: "STRING",
              enum: [...VALID_ACTIONS],
              description:
                "The recommended recovery action from the closed enum",
            },
            rationale: {
              type: "STRING",
              description: "Reasoning for the chosen action",
            },
          },
          required: ["root_cause_summary", "selected_action", "rationale"],
        },
      },
    };

    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 503 || response.status === 429) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
      }
      break;
    }

    if (!response || !response.ok) {
      const errText = await response?.text().catch(() => "(unreadable)") ?? "(no response)";
      throw new Error(
        `GeminiLlmClient: Gemini API returned HTTP ${response?.status}: ${errText.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as GeminiResponse;

    if (data.error) {
      throw new Error(
        `GeminiLlmClient: Gemini API error: ${data.error.message ?? "unknown"}`,
      );
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(
        "GeminiLlmClient: Gemini API returned no text in response.",
      );
    }

    return text;
  }
}
