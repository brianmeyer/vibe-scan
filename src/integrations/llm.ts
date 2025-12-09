/**
 * LLM integration module for Vibe Scan.
 *
 * This module provides an interface to call Groq's OpenAI-compatible API
 * to analyze code snippets for "vibe-coded" / production-risk issues.
 *
 * IMPORTANT NOTES:
 * - This is experimental and should NOT block CI on failures.
 * - The LLM is advisory and can be noisy; results should be used as hints.
 * - Callers should treat `null` returns as "LLM unavailable" and fall back
 *   to static analysis only.
 * - LLM issues do NOT affect the Vibe Score; they are advisory only.
 */

import OpenAI from "openai";
import { config } from "../env";

// ============================================================================
// Types
// ============================================================================

/**
 * Production risk categories the LLM classifies issues into.
 * These are high-level categories for organizing LLM findings.
 */
export type LlmIssueKind =
  | "SCALING_RISK"
  | "CONCURRENCY_RISK"
  | "ENVIRONMENT_ASSUMPTION"
  | "DATA_CONTRACT_RISK"
  | "OBSERVABILITY_GAP"
  | "RESILIENCE_GAP";

/**
 * Human-readable labels for each LLM issue kind.
 */
export const LLM_ISSUE_KIND_LABELS: Record<LlmIssueKind, string> = {
  SCALING_RISK: "Scaling Risk",
  CONCURRENCY_RISK: "Concurrency Risk",
  ENVIRONMENT_ASSUMPTION: "Environment Assumption",
  DATA_CONTRACT_RISK: "Data Contract Risk",
  OBSERVABILITY_GAP: "Observability Gap",
  RESILIENCE_GAP: "Resilience Gap",
};

/**
 * Severity levels for LLM issues.
 */
export type LlmSeverity = "low" | "medium" | "high";

/**
 * A compact summary of a static finding to feed into the LLM.
 * This is a simplified version of the full Finding type for token efficiency.
 */
export interface StaticFindingSummary {
  /** The rule ID that triggered this finding */
  ruleId: string;
  /** Human-readable category (same as ruleId or a label) */
  kind: string;
  /** File path where the issue was found */
  file: string;
  /** Line number in the file */
  line: number;
  /** Severity level */
  severity: "low" | "medium" | "high";
  /** Short human-readable description */
  summary: string;
}

/**
 * A single issue identified by the LLM.
 */
export interface LlmIssue {
  /** High-level production risk category */
  kind: LlmIssueKind;
  /** Short human-readable title (max 10 words) */
  title: string;
  /** File where the issue was found (optional for cross-cutting issues) */
  file?: string;
  /** Line number in the file (optional) */
  line?: number;
  /** Brief explanation of the issue (1-2 sentences) */
  summary: string;
  /** Code snippet showing the problematic pattern (optional) */
  evidenceSnippet?: string;
  /** Suggested fix or mitigation (optional, 1-2 sentences) */
  suggestedFix?: string;
  /** Issue severity */
  severity: LlmSeverity;
}

/**
 * The overall result from LLM analysis.
 */
export interface LlmAnalysisResult {
  /** List of identified issues */
  issues: LlmIssue[];
  /** Optional high-level summary of architecture/risk patterns (2-4 sentences) */
  architectureSummary?: string;
}

// ============================================================================
// OpenAI Client Setup (configured for Groq)
// ============================================================================

/**
 * Create an OpenAI client configured to use Groq's API.
 * We lazily create this to avoid errors if GROQ_API_KEY is not set.
 */
function createOpenAIClient(): OpenAI | null {
  if (!config.GROQ_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: config.GROQ_API_KEY,
    baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  });
}

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Build the prompt for production risk analysis.
 * Includes static findings as context for the LLM to reason about.
 */
export function buildVibePrompt(params: {
  file: string;
  language?: string;
  snippet: string;
  diffContext?: string;
  staticFindings?: StaticFindingSummary[];
}): string {
  const { file, language, snippet, diffContext, staticFindings } = params;

  const languageHint = language ? ` (${language})` : "";
  const diffSection = diffContext
    ? `\n\nDiff context (surrounding changes):\n\`\`\`\n${diffContext}\n\`\`\``
    : "";

  // Build static findings section if provided
  let staticFindingsSection = "";
  if (staticFindings && staticFindings.length > 0) {
    // Cap at 50 findings to avoid token explosion
    const cappedFindings = staticFindings.slice(0, 50);
    const staticFindingsJson = JSON.stringify(cappedFindings, null, 2);
    staticFindingsSection = `
Here is a compact JSON summary of static analysis findings that were already detected:

\`\`\`json
${staticFindingsJson}
\`\`\`

Use these as primary evidence of potential problems. Cluster related findings into higher-level issues rather than re-listing each one individually. Connect issues to environment assumptions, observability gaps, and resilience gaps where relevant.

`;
  }

  return `You are a senior production engineer analyzing backend code for production risks in a startup environment.
${staticFindingsSection}
Your task is to identify issues and classify them into the following production risk categories:

**SCALING_RISK**: Problems that will cause performance or cost issues as traffic grows.
- Unbounded queries (SELECT *, findMany without limits)
- N+1 query patterns
- Per-item remote calls in loops
- Loading entire datasets into memory
- Missing pagination or batching

**CONCURRENCY_RISK**: Race conditions and contention issues.
- Shared mutable state across requests
- Non-atomic check-then-act patterns (find-then-create races)
- Retry storms without exponential backoff
- Unsafe parallel mutations
- File writes to shared paths

**ENVIRONMENT_ASSUMPTION**: Hidden assumptions about infrastructure/dependencies.
- Assuming APIs are always available or fast
- Hardcoded timeouts that are too short/long
- No handling for rate limits or throttling
- Single-region or single-instance assumptions
- Missing graceful degradation

**DATA_CONTRACT_RISK**: Assumptions about data shapes and validation.
- Missing input validation (request bodies, query params)
- Non-null assertions on external data
- Type assertions without runtime checks
- Inconsistent response shapes
- Missing idempotency in event handlers

**OBSERVABILITY_GAP**: Missing instrumentation for production debugging.
- No structured logging in critical paths
- Silent failures (empty catch blocks)
- Missing metrics or tracing
- console.log instead of proper logging
- Errors that would be hard to debug in production

**RESILIENCE_GAP**: Missing fault tolerance around fragile operations.
- External calls without timeouts
- No retry logic for transient failures
- Missing circuit breakers
- No dead-letter queues for failed jobs
- No fallbacks for degraded dependencies

Analyze this code from file: ${file}${languageHint}

Code snippet:
\`\`\`
${snippet}
\`\`\`${diffSection}

Respond ONLY with a JSON object matching this exact TypeScript interface (no markdown, no extra text):

{
  "issues": [
    {
      "kind": "SCALING_RISK" | "CONCURRENCY_RISK" | "ENVIRONMENT_ASSUMPTION" | "DATA_CONTRACT_RISK" | "OBSERVABILITY_GAP" | "RESILIENCE_GAP",
      "title": "short title (max 10 words)",
      "file": "optional file path",
      "line": optional line number,
      "summary": "1-2 sentence explanation",
      "evidenceSnippet": "optional code snippet showing the issue",
      "suggestedFix": "optional 1-2 sentence fix suggestion",
      "severity": "low" | "medium" | "high"
    }
  ],
  "architectureSummary": "optional 2-4 sentence summary of the highest-risk patterns"
}

Severity guidelines:
- "low": Minor concern, nice to fix but not urgent
- "medium": Should fix before production, could cause issues under load
- "high": Critical, must fix before production, will cause failures

Rules:
- If there are no meaningful issues, return { "issues": [], "architectureSummary": null }
- Focus on grouping and explaining the most important issues based on the static findings
- Do not re-list every finding individually; cluster related findings into a smaller number of higher-level issues
- When possible, connect issues to environment assumptions, observability gaps, and resilience gaps
- Keep explanations and fixes concise (max 2 sentences each)
- Do NOT include any text outside the JSON object
- Prioritize scaling issues that grow with data size or tenant count`;
}

// ============================================================================
// Main Analysis Function
// ============================================================================

/**
 * Analyze a code snippet using the LLM.
 *
 * @param params - Analysis parameters
 * @returns LlmAnalysisResult or null if LLM is unavailable/fails
 */
export async function analyzeSnippetWithLlm(params: {
  file: string;
  language?: string;
  snippet: string;
  diffContext?: string;
  modelName?: string;
  staticFindings?: StaticFindingSummary[];
}): Promise<LlmAnalysisResult | null> {
  // Check if API key is configured
  if (!config.GROQ_API_KEY) {
    console.warn("[LLM] GROQ_API_KEY not configured, skipping LLM analysis");
    return null;
  }

  const openai = createOpenAIClient();
  if (!openai) {
    console.warn("[LLM] Failed to create OpenAI client");
    return null;
  }

  const model = params.modelName || "llama-3.1-8b-instant";
  const prompt = buildVibePrompt({
    file: params.file,
    language: params.language,
    snippet: params.snippet,
    diffContext: params.diffContext,
    staticFindings: params.staticFindings,
  });

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 1024,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      console.warn("[LLM] Empty response from model");
      return {
        issues: [],
        architectureSummary: undefined,
      };
    }

    // Parse JSON response
    let parsed: unknown;
    try {
      // Try to extract JSON from the response (in case there's extra text)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : content;
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error("[LLM] Failed to parse JSON response:", parseError);
      console.error("[LLM] Raw response:", content);
      return {
        issues: [],
        architectureSummary: undefined,
      };
    }

    // Validate and normalize the response
    return validateAndNormalize(parsed, params.file);
  } catch (error) {
    console.error("[LLM] API call failed:", error);
    return null;
  }
}

// ============================================================================
// Validation and Normalization
// ============================================================================

/**
 * Valid LLM issue kinds for validation.
 */
const VALID_KINDS: LlmIssueKind[] = [
  "SCALING_RISK",
  "CONCURRENCY_RISK",
  "ENVIRONMENT_ASSUMPTION",
  "DATA_CONTRACT_RISK",
  "OBSERVABILITY_GAP",
  "RESILIENCE_GAP",
];

/**
 * Valid severity values.
 */
const VALID_SEVERITIES: LlmSeverity[] = ["low", "medium", "high"];

/**
 * Validate and normalize the parsed LLM response.
 */
function validateAndNormalize(parsed: unknown, defaultFile: string): LlmAnalysisResult {
  const defaultResult: LlmAnalysisResult = {
    issues: [],
    architectureSummary: undefined,
  };

  if (!parsed || typeof parsed !== "object") {
    console.warn("[LLM] Invalid response structure");
    return defaultResult;
  }

  const obj = parsed as Record<string, unknown>;

  // Extract architectureSummary if present
  const architectureSummary =
    typeof obj.architectureSummary === "string" && obj.architectureSummary.trim()
      ? obj.architectureSummary.trim()
      : undefined;

  // Validate issues array
  const issues: LlmIssue[] = [];
  if (Array.isArray(obj.issues)) {
    for (const item of obj.issues) {
      if (item && typeof item === "object") {
        const issue = item as Record<string, unknown>;

        // Validate and normalize kind
        const kind = VALID_KINDS.includes(issue.kind as LlmIssueKind)
          ? (issue.kind as LlmIssueKind)
          : "SCALING_RISK"; // Default to SCALING_RISK for unknown kinds

        // Validate and normalize severity
        const severity = VALID_SEVERITIES.includes(issue.severity as LlmSeverity)
          ? (issue.severity as LlmSeverity)
          : "medium";

        // Extract required fields with defaults
        const title = typeof issue.title === "string" ? issue.title : "Unknown issue";
        const summary =
          typeof issue.summary === "string"
            ? issue.summary
            : typeof issue.explanation === "string"
              ? issue.explanation // Backwards compat
              : "No summary provided";

        // Extract optional fields
        const file = typeof issue.file === "string" ? issue.file : defaultFile;
        const line = typeof issue.line === "number" ? issue.line : undefined;
        const evidenceSnippet =
          typeof issue.evidenceSnippet === "string" ? issue.evidenceSnippet : undefined;
        const suggestedFix =
          typeof issue.suggestedFix === "string" ? issue.suggestedFix : undefined;

        issues.push({
          kind,
          title,
          file,
          line,
          summary,
          evidenceSnippet,
          suggestedFix,
          severity,
        });
      }
    }
  }

  return {
    issues,
    architectureSummary,
  };
}

// ============================================================================
// Utility Functions for Consumers
// ============================================================================

/**
 * Convert LlmSeverity to a numeric value for sorting/filtering.
 * Useful for compatibility with code that expects numeric severity.
 */
export function severityToNumber(severity: LlmSeverity): 1 | 2 | 3 {
  switch (severity) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
  }
}

/**
 * Group issues by their kind for display purposes.
 */
export function groupIssuesByKind(issues: LlmIssue[]): Map<LlmIssueKind, LlmIssue[]> {
  const grouped = new Map<LlmIssueKind, LlmIssue[]>();

  for (const issue of issues) {
    const existing = grouped.get(issue.kind) || [];
    existing.push(issue);
    grouped.set(issue.kind, existing);
  }

  return grouped;
}
