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
import { getRedisClient } from "../redis";

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
 * Supports tiered analysis with optional file structure and full content.
 */
export function buildVibePrompt(params: {
  file: string;
  language?: string;
  snippet: string;
  diffContext?: string;
  staticFindings?: StaticFindingSummary[];
  /** Optional structural summary of the file (imports, definitions, stats) */
  fileStructure?: string;
  /** Optional full file content for deep analysis */
  fullContent?: string;
}): string {
  const { file, language, snippet, diffContext, staticFindings, fileStructure, fullContent } = params;

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

  // Build file structure context section if provided
  let fileStructureSection = "";
  if (fileStructure) {
    fileStructureSection = `
### File Dependency & Structure Context

Use this structural summary to understand the file's dependencies, exports, and overall organization. This helps identify potential issues with external dependencies, missing error handling for imports, and architectural concerns.

${fileStructure}

`;
  }

  // Build full content section if provided (takes precedence over snippet for analysis)
  let codeSection = "";
  if (fullContent) {
    codeSection = `
### Full File Context

Use this complete file content to verify deep logical issues like race conditions, unhandled errors across function boundaries, and cross-cutting concerns. The snippet below shows only the changed lines.

Full file content:
\`\`\`
${fullContent}
\`\`\`

Changed lines (snippet):
\`\`\`
${snippet}
\`\`\`${diffSection}`;
  } else {
    codeSection = `
Code snippet:
\`\`\`
${snippet}
\`\`\`${diffSection}`;
  }

  return `You are a senior production engineer analyzing backend code for production risks in a startup environment.
${fileStructureSection}${staticFindingsSection}
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
${codeSection}

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
// Token Quota Management
// ============================================================================

/** Expiry time for quota keys (35 days in seconds) */
const QUOTA_KEY_EXPIRY_SECONDS = 35 * 24 * 60 * 60;

/**
 * Generate the Redis key for an installation's monthly token usage.
 */
function getQuotaKey(installationId: number): string {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `vibe:usage:${installationId}:${yearMonth}`;
}

/**
 * Check if an installation has exceeded their monthly token quota.
 */
async function isQuotaExceeded(installationId: number): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) {
    // No Redis = no quota enforcement
    return false;
  }

  try {
    const key = getQuotaKey(installationId);
    const usage = await redis.get(key);
    const currentUsage = usage ? parseInt(usage, 10) : 0;
    const limit = config.MONTHLY_TOKEN_QUOTA;

    if (currentUsage >= limit) {
      console.warn(`[LLM] Quota exceeded for installation ${installationId}: ${currentUsage}/${limit} tokens`);
      return true;
    }
    return false;
  } catch (error) {
    console.error("[LLM] Error checking quota:", error);
    return false; // Fail open
  }
}

/**
 * Record token usage for an installation.
 */
async function recordTokenUsage(installationId: number, tokens: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const key = getQuotaKey(installationId);
    await redis.incrby(key, tokens);
    await redis.expire(key, QUOTA_KEY_EXPIRY_SECONDS);
  } catch (error) {
    console.error("[LLM] Error recording token usage:", error);
  }
}

/**
 * Get current token usage for an installation.
 */
export async function getTokenUsage(installationId: number): Promise<number> {
  const redis = getRedisClient();
  if (!redis) return 0;

  try {
    const key = getQuotaKey(installationId);
    const usage = await redis.get(key);
    return usage ? parseInt(usage, 10) : 0;
  } catch (error) {
    console.error("[LLM] Error getting token usage:", error);
    return 0;
  }
}

// ============================================================================
// JSON Repair Utilities
// ============================================================================

/**
 * Attempt to repair a truncated JSON response from the LLM.
 * This handles cases where the response was cut off mid-JSON due to token limits.
 *
 * Strategy:
 * 1. Find the last complete array element (ending with })
 * 2. Close any open arrays and objects
 *
 * @param content - The potentially truncated JSON string
 * @returns Repaired JSON string or null if repair is not possible
 */
function attemptJsonRepair(content: string): string | null {
  // Only attempt repair if it looks like a truncated JSON object with issues array
  if (!content.includes('"issues"') || !content.includes('[')) {
    return null;
  }

  // Find the start of the JSON object
  const jsonStart = content.indexOf('{');
  if (jsonStart === -1) {
    return null;
  }

  let jsonStr = content.slice(jsonStart);

  // Try to find the last complete issue object by finding the last complete "}"
  // that appears to end an issue object (followed by comma or appears after "severity")
  const issuesMatch = jsonStr.match(/"issues"\s*:\s*\[/);
  if (!issuesMatch) {
    return null;
  }

  // Find all complete issue objects (those that have a closing brace after severity)
  // Look for pattern: "severity": "..." } which ends an issue
  const severityPattern = /"severity"\s*:\s*"(?:low|medium|high)"\s*\}/g;
  let lastCompleteIssue = -1;
  let match;

  // vibescan-ignore-next-line UNSAFE_EVAL
  while ((match = severityPattern.exec(jsonStr)) !== null) {
    lastCompleteIssue = match.index + match[0].length;
  }

  if (lastCompleteIssue === -1) {
    // No complete issues found, return minimal valid structure
    return '{"issues": [], "architectureSummary": null}';
  }

  // Truncate at the last complete issue and close the structure
  jsonStr = jsonStr.slice(0, lastCompleteIssue);

  // Close the issues array and the outer object
  jsonStr += ']}';

  return jsonStr;
}

// ============================================================================
// Retry Logic
// ============================================================================

/** Maximum number of retry attempts for transient failures */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff */
const BASE_DELAY_MS = 1000;

/**
 * Check if an error is likely transient and worth retrying.
 */
function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Network errors, timeouts, rate limits, and server errors
    return (
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("socket") ||
      message.includes("rate limit") ||
      message.includes("429") ||
      message.includes("500") ||
      message.includes("502") ||
      message.includes("503") ||
      message.includes("504")
    );
  }
  return false;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic and exponential backoff.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  baseDelayMs: number = BASE_DELAY_MS
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    // vibescan-ignore-next-line SILENT_ERROR
    } catch (error) {
      lastError = error;

      // Don't retry non-transient errors
      if (!isTransientError(error)) {
        throw error;
      }

      // Don't retry after the last attempt
      if (attempt === maxRetries) {
        console.error(`[LLM] All ${maxRetries + 1} attempts failed, giving up`);
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
      console.warn(
        `[LLM] Transient error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms:`,
        error instanceof Error ? error.message : "unknown"
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

// ============================================================================
// Main Analysis Function
// ============================================================================

/**
 * Analyze a code snippet using the LLM.
 *
 * @param params - Analysis parameters
 * @returns LlmAnalysisResult or null if LLM is unavailable/fails/quota exceeded
 */
export async function analyzeSnippetWithLlm(params: {
  file: string;
  language?: string;
  snippet: string;
  diffContext?: string;
  modelName?: string;
  staticFindings?: StaticFindingSummary[];
  /** Optional structural summary of the file (imports, definitions, stats) */
  fileStructure?: string;
  /** Optional full file content for deep analysis */
  fullContent?: string;
  /** GitHub App installation ID for quota tracking */
  installationId?: number;
}): Promise<LlmAnalysisResult | null> {
  // Check if API key is configured
  if (!config.GROQ_API_KEY) {
    console.warn("[LLM] GROQ_API_KEY not configured, skipping LLM analysis");
    return null;
  }

  // Check quota if installationId is provided
  if (params.installationId) {
    const exceeded = await isQuotaExceeded(params.installationId);
    if (exceeded) {
      console.warn(`[LLM] Quota exceeded for installation ${params.installationId}, skipping LLM analysis`);
      return null;
    }
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
    fileStructure: params.fileStructure,
    fullContent: params.fullContent,
  });

  try {
    // Wrap API call with retry logic for transient failures
    const completion = await withRetry(() =>
      openai.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 4096,
      })
    );

    // Record token usage if installationId is provided
    if (params.installationId && completion.usage) {
      const totalTokens = completion.usage.total_tokens || 0;
      await recordTokenUsage(params.installationId, totalTokens);
      console.log(`[LLM] Recorded ${totalTokens} tokens for installation ${params.installationId}`);
    }

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
      // Attempt to repair truncated JSON response
      const repaired = attemptJsonRepair(content);
      if (repaired) {
        try {
          parsed = JSON.parse(repaired);
          console.warn("[LLM] Successfully repaired truncated JSON response");
        // vibescan-ignore-next-line SILENT_ERROR
        } catch (repairError) {
          // Repair failed, log both errors and return empty
          console.error("[LLM] Failed to parse JSON response:", parseError instanceof Error ? parseError.message : "unknown");
          console.error("[LLM] Repair also failed:", repairError instanceof Error ? repairError.message : "unknown");
          // Truncate response to avoid logging potentially echoed secrets
          const truncated = content.length > 200 ? content.slice(0, 200) + "...[truncated]" : content;
          console.error("[LLM] Raw response (truncated):", truncated);
          return {
            issues: [],
            architectureSummary: undefined,
          };
        }
      } else {
        console.error("[LLM] Failed to parse JSON response:", parseError instanceof Error ? parseError.message : "unknown");
        // Truncate response to avoid logging potentially echoed secrets
        const truncated = content.length > 200 ? content.slice(0, 200) + "...[truncated]" : content;
        console.error("[LLM] Raw response (truncated):", truncated);
        return {
          issues: [],
          architectureSummary: undefined,
        };
      }
    }

    // Validate and normalize the response
    return validateAndNormalize(parsed, params.file);
  } catch (error) {
    console.error("[LLM] API call failed:", error instanceof Error ? error.message : "unknown error");
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
