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
    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 1024,
    });

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
      console.error("[LLM] Failed to parse JSON response:", parseError instanceof Error ? parseError.message : "unknown");
      // Truncate response to avoid logging potentially echoed secrets
      const truncated = content.length > 200 ? content.slice(0, 200) + "...[truncated]" : content;
      console.error("[LLM] Raw response (truncated):", truncated);
      return {
        issues: [],
        architectureSummary: undefined,
      };
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

// ============================================================================
// Executive Summary Generation
// ============================================================================

/**
 * Input for generating an executive summary.
 */
export interface ExecutiveSummaryInput {
  /** Grouped static findings by rule kind */
  findingsByKind: Map<string, { count: number; severity: string; files: string[] }>;
  /** Total findings count */
  totalFindings: number;
  /** High severity count */
  highCount: number;
  /** Medium severity count */
  mediumCount: number;
  /** Vibe score (0-100) */
  vibeScore: number;
  /** Installation ID for quota tracking */
  installationId?: number;
}

/**
 * Build a prompt for generating an executive summary.
 */
function buildExecutiveSummaryPrompt(input: ExecutiveSummaryInput): string {
  const findingsList = Array.from(input.findingsByKind.entries())
    .map(([kind, data]) => `- ${kind}: ${data.count} finding(s), severity=${data.severity}, files: ${data.files.slice(0, 3).join(", ")}${data.files.length > 3 ? ` (+${data.files.length - 3} more)` : ""}`)
    .join("\n");

  return `You are a senior software engineer reviewing a pull request for production readiness.

Based on the following static analysis findings, write a concise 2-3 sentence executive summary that:
1. Highlights the most critical issues that need immediate attention
2. Groups related problems (e.g., "multiple network calls lack error handling")
3. Suggests the highest-priority fix

FINDINGS SUMMARY:
Total: ${input.totalFindings} findings (${input.highCount} high, ${input.mediumCount} medium)
Vibe Score: ${input.vibeScore}/100

BY CATEGORY:
${findingsList}

RULES:
- Be concise and actionable (2-3 sentences max)
- Focus on production risk, not code style
- Use specific numbers ("7 fetch calls" not "several calls")
- If score is 0-30, emphasize critical blockers
- If score is 31-70, note areas needing attention
- If score is 71-100, acknowledge good state with minor suggestions

Respond with ONLY the summary text, no JSON or formatting.`;
}

/**
 * Generate an executive summary of findings using LLM.
 * Returns null if LLM is unavailable or quota exceeded.
 */
export async function generateExecutiveSummary(
  input: ExecutiveSummaryInput
): Promise<string | null> {
  // Check if API key is configured
  if (!config.GROQ_API_KEY) {
    console.warn("[LLM] GROQ_API_KEY not configured, skipping executive summary");
    return null;
  }

  // Check quota if installationId is provided
  if (input.installationId) {
    const quotaExceeded = await isQuotaExceeded(input.installationId);
    if (quotaExceeded) {
      console.warn("[LLM] Quota exceeded, skipping executive summary");
      return null;
    }
  }

  try {
    const client = new OpenAI({
      apiKey: config.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });

    const prompt = buildExecutiveSummaryPrompt(input);

    const completion = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 256,
    });

    // Record token usage
    if (input.installationId && completion.usage) {
      const totalTokens = completion.usage.total_tokens || 0;
      await recordTokenUsage(input.installationId, totalTokens);
      console.log(`[LLM] Executive summary used ${totalTokens} tokens`);
    }

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      console.warn("[LLM] Empty executive summary response");
      return null;
    }

    return content.trim();
  } catch (error) {
    // vibescan-ignore-next-line SILENT_ERROR - Intentional: LLM failure shouldn't block analysis
    console.error("[LLM] Executive summary generation failed:", error instanceof Error ? error.message : "unknown");
    return null;
  }
}

// ============================================================================
// Finding Validation with Confidence Scoring
// ============================================================================

/**
 * A static finding with LLM-assigned confidence score.
 */
export interface ValidatedFinding {
  /** Original rule ID */
  ruleId: string;
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Original severity */
  severity: "low" | "medium" | "high";
  /** Original summary */
  summary: string;
  /** LLM-assigned confidence score (0.0 - 1.0) */
  confidence: number;
  /** LLM reasoning for the confidence score */
  reasoning?: string;
  /** Whether the finding is likely a false positive */
  likelyFalsePositive: boolean;
}

/**
 * Input for validating findings with LLM.
 */
export interface ValidateFindingsInput {
  /** Static findings to validate */
  findings: StaticFindingSummary[];
  /** Code snippets for context, keyed by file path */
  codeContext: Map<string, string>;
  /** Installation ID for quota tracking */
  installationId?: number;
  /** Confidence threshold (findings below this are marked as likely false positive) */
  confidenceThreshold?: number;
}

/**
 * Result of validating findings.
 */
export interface ValidateFindingsResult {
  /** Validated findings with confidence scores */
  validatedFindings: ValidatedFinding[];
  /** Number of findings filtered as likely false positives */
  filteredCount: number;
  /** Total tokens used for validation */
  tokensUsed: number;
}

/**
 * Build a prompt for validating static findings.
 */
function buildValidationPrompt(
  findings: StaticFindingSummary[],
  codeContext: Map<string, string>
): string {
  // Group findings by file for context
  const findingsByFile = new Map<string, StaticFindingSummary[]>();
  for (const finding of findings) {
    const existing = findingsByFile.get(finding.file) || [];
    existing.push(finding);
    findingsByFile.set(finding.file, existing);
  }

  // Build code context sections
  const codeContextSections: string[] = [];
  for (const [file, code] of codeContext.entries()) {
    const fileFindings = findingsByFile.get(file) || [];
    if (fileFindings.length > 0) {
      codeContextSections.push(`### ${file}
\`\`\`
${code.slice(0, 3000)}${code.length > 3000 ? "\n... (truncated)" : ""}
\`\`\`

Findings in this file:
${fileFindings.map(f => `- Line ${f.line}: ${f.ruleId} - ${f.summary}`).join("\n")}`);
    }
  }

  const findingsJson = JSON.stringify(
    findings.map(f => ({
      id: `${f.file}:${f.line}:${f.ruleId}`,
      ruleId: f.ruleId,
      file: f.file,
      line: f.line,
      severity: f.severity,
      summary: f.summary,
    })),
    null,
    2
  );

  return `You are a senior production engineer validating static analysis findings for accuracy.

Your task is to review each finding and assign a confidence score (0.0 to 1.0) indicating how likely it is to be a TRUE POSITIVE (real production risk).

IMPORTANT SCORING GUIDELINES:
- 0.9-1.0: Definite true positive - clear production risk with strong evidence
- 0.7-0.89: Likely true positive - probable risk, may need context
- 0.5-0.69: Uncertain - could go either way, needs human review
- 0.3-0.49: Likely false positive - pattern match but probably safe in context
- 0.0-0.29: Definite false positive - clear safe usage, not a real risk

COMMON FALSE POSITIVE PATTERNS TO WATCH FOR:
- Array.filter(), Array.map() flagged as database queries (UNBOUNDED_QUERY)
- Intentional empty catch blocks with logging (SILENT_ERROR)
- Test/mock code flagged for production risks
- TypeScript type narrowing misidentified as unsafe
- Environment-specific code with proper guards
- Prototype/development files in expected locations

ARCHITECTURE-SPECIFIC VALIDATION (be especially careful):
- STATEFUL_SERVICE: Only flag if actual shared mutable state across requests
- PROTOTYPE_INFRA: Only flag if truly temporary/experimental patterns
- UNBOUNDED_QUERY: Must be actual database/API calls, not array operations
- GLOBAL_MUTATION: Check if mutation is initialization vs. runtime modification

${codeContextSections.length > 0 ? `CODE CONTEXT:\n${codeContextSections.join("\n\n")}` : ""}

FINDINGS TO VALIDATE:
\`\`\`json
${findingsJson}
\`\`\`

OUTPUT FORMAT:
You MUST respond with ONLY a valid JSON array. No explanations, no markdown, no code blocks - just the raw JSON array.

Example output:
[{"id":"src/file.ts:10:RULE_ID","confidence":0.8,"reasoning":"Real risk because..."},{"id":"src/other.ts:20:RULE_ID","confidence":0.2,"reasoning":"False positive because..."}]

Your response (just the JSON array, nothing else):

RULES:
- Output ONLY the JSON array - no text before or after
- Validate EVERY finding in the input list
- Be conservative - when in doubt, give benefit of the doubt to the code (lower confidence)
- Focus on whether the finding represents a REAL production risk
- Consider the code context when available`;
}

/**
 * Validate static findings with LLM to filter false positives and assign confidence scores.
 *
 * This is the key function for implementing broad static detection + LLM filtering.
 * It takes static findings and returns them with confidence scores, allowing the
 * display layer to filter or highlight based on confidence.
 */
export async function validateFindingsWithLlm(
  input: ValidateFindingsInput
): Promise<ValidateFindingsResult | null> {
  const { findings, codeContext, installationId, confidenceThreshold = 0.6 } = input;

  // Check if API key is configured
  if (!config.GROQ_API_KEY) {
    console.warn("[LLM] GROQ_API_KEY not configured, skipping finding validation");
    return null;
  }

  // Check quota if installationId is provided
  if (installationId) {
    const quotaExceeded = await isQuotaExceeded(installationId);
    if (quotaExceeded) {
      console.warn("[LLM] Quota exceeded, skipping finding validation");
      return null;
    }
  }

  // Nothing to validate
  if (findings.length === 0) {
    return {
      validatedFindings: [],
      filteredCount: 0,
      tokensUsed: 0,
    };
  }

  // Cap findings to avoid token explosion (process in batches if needed)
  const MAX_FINDINGS_PER_CALL = 30;
  const cappedFindings = findings.slice(0, MAX_FINDINGS_PER_CALL);

  if (findings.length > MAX_FINDINGS_PER_CALL) {
    console.warn(`[LLM] Capping validation to ${MAX_FINDINGS_PER_CALL} findings (${findings.length} total)`);
  }

  try {
    const client = new OpenAI({
      apiKey: config.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });

    const prompt = buildValidationPrompt(cappedFindings, codeContext);

    const completion = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 2048,
    });

    const tokensUsed = completion.usage?.total_tokens || 0;

    // Record token usage
    if (installationId) {
      await recordTokenUsage(installationId, tokensUsed);
      console.log(`[LLM] Finding validation used ${tokensUsed} tokens`);
    }

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      console.warn("[LLM] Empty validation response");
      return null;
    }

    // Parse JSON response - try multiple extraction methods
    let parsed: unknown;
    try {
      // Method 1: Try to find JSON array directly
      let jsonStr = content;

      // Method 2: Extract from markdown code block
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      } else {
        // Method 3: Find JSON array pattern
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
      }

      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error("[LLM] Failed to parse validation response:", parseError instanceof Error ? parseError.message : "unknown");
      // Log truncated response for debugging
      const truncated = content.length > 500 ? content.slice(0, 500) + "...[truncated]" : content;
      console.error("[LLM] Raw response:", truncated);
      return null;
    }

    if (!Array.isArray(parsed)) {
      console.warn("[LLM] Invalid validation response structure - expected array, got:", typeof parsed);
      return null;
    }

    console.log(`[LLM] Successfully parsed ${parsed.length} validation results`);

    // Build a map of validation results
    const validationMap = new Map<string, { confidence: number; reasoning?: string }>();
    for (const item of parsed) {
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (typeof obj.id === "string" && typeof obj.confidence === "number") {
          validationMap.set(obj.id, {
            confidence: Math.max(0, Math.min(1, obj.confidence)),
            reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
          });
        }
      }
    }

    // Map findings to validated findings
    const validatedFindings: ValidatedFinding[] = [];
    let filteredCount = 0;

    for (const finding of cappedFindings) {
      const id = `${finding.file}:${finding.line}:${finding.ruleId}`;
      const validation = validationMap.get(id);

      // Default to 0.7 confidence if LLM didn't validate this finding
      const confidence = validation?.confidence ?? 0.7;
      const likelyFalsePositive = confidence < confidenceThreshold;

      if (likelyFalsePositive) {
        filteredCount++;
      }

      validatedFindings.push({
        ruleId: finding.ruleId,
        file: finding.file,
        line: finding.line,
        severity: finding.severity,
        summary: finding.summary,
        confidence,
        reasoning: validation?.reasoning,
        likelyFalsePositive,
      });
    }

    // Add any findings that weren't capped (without validation)
    for (let i = MAX_FINDINGS_PER_CALL; i < findings.length; i++) {
      const finding = findings[i];
      validatedFindings.push({
        ruleId: finding.ruleId,
        file: finding.file,
        line: finding.line,
        severity: finding.severity,
        summary: finding.summary,
        confidence: 0.7, // Default confidence for uncapped findings
        reasoning: "Not validated due to batch limit",
        likelyFalsePositive: false,
      });
    }

    return {
      validatedFindings,
      filteredCount,
      tokensUsed,
    };
  } catch (error) {
    // vibescan-ignore-next-line SILENT_ERROR - Intentional: LLM failure shouldn't block analysis
    console.error("[LLM] Finding validation failed:", error instanceof Error ? error.message : "unknown");
    return null;
  }
}
