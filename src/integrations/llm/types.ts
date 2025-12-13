/**
 * LLM integration types and constants.
 */

// ============================================================================
// Issue Types
// ============================================================================

/**
 * Production risk categories the LLM classifies issues into.
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
 */
export interface StaticFindingSummary {
  ruleId: string;
  kind: string;
  file: string;
  line: number;
  severity: "low" | "medium" | "high";
  summary: string;
}

/**
 * A single issue identified by the LLM.
 */
export interface LlmIssue {
  kind: LlmIssueKind;
  title: string;
  file?: string;
  line?: number;
  summary: string;
  evidenceSnippet?: string;
  suggestedFix?: string;
  severity: LlmSeverity;
}

/**
 * The overall result from LLM analysis.
 */
export interface LlmAnalysisResult {
  issues: LlmIssue[];
  architectureSummary?: string;
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * A static finding with LLM-assigned confidence score.
 */
export interface ValidatedFinding {
  ruleId: string;
  file: string;
  line: number;
  severity: "low" | "medium" | "high";
  summary: string;
  confidence: number;
  reasoning?: string;
  likelyFalsePositive: boolean;
}

/**
 * Input for validating findings with LLM.
 */
export interface ValidateFindingsInput {
  findings: StaticFindingSummary[];
  codeContext: Map<string, string>;
  installationId?: number;
  confidenceThreshold?: number;
}

/**
 * Result of validating findings.
 */
export interface ValidateFindingsResult {
  validatedFindings: ValidatedFinding[];
  filteredCount: number;
  tokensUsed: number;
}

// ============================================================================
// Executive Summary Types
// ============================================================================

/**
 * Input for generating an executive summary.
 */
export interface ExecutiveSummaryInput {
  findingsByKind: Map<string, { count: number; severity: string; files: string[] }>;
  totalFindings: number;
  highCount: number;
  mediumCount: number;
  vibeScore: number;
  installationId?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Valid LLM issue kinds for validation */
export const VALID_KINDS: LlmIssueKind[] = [
  "SCALING_RISK",
  "CONCURRENCY_RISK",
  "ENVIRONMENT_ASSUMPTION",
  "DATA_CONTRACT_RISK",
  "OBSERVABILITY_GAP",
  "RESILIENCE_GAP",
];

/** Valid severity values */
export const VALID_SEVERITIES: LlmSeverity[] = ["low", "medium", "high"];

/** Expiry time for quota keys (35 days in seconds) */
export const QUOTA_KEY_EXPIRY_SECONDS = 35 * 24 * 60 * 60;

/** Maximum number of retry attempts for transient failures */
export const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff */
export const BASE_DELAY_MS = 1000;

/** Maximum findings to validate per LLM call */
export const MAX_FINDINGS_PER_CALL = 30;

// ============================================================================
// Model Tiers
// ============================================================================

/** Fast model for simple tasks */
export const MODEL_FAST = "llama-3.1-8b-instant";

/**
 * Reasoning model for complex validation.
 * Using Qwen3-32B for better prompt adherence and structured output.
 * Community testing shows Qwen3 follows instructions more reliably than GPT-OSS.
 * - 535 tok/s on Groq, $0.29/M input, $0.59/M output
 * - Better at diff-based editing and JSON formatting
 * - Production ready with 128K context window
 */
export const MODEL_REASONING = "qwen/qwen3-32b";

/** Balanced model for summaries */
export const MODEL_BALANCED = "openai/gpt-oss-20b";

/**
 * Rules that require deeper reasoning to validate properly.
 * These benefit from a larger model that can:
 * - Distinguish Array methods from database queries
 * - Trace error handling flow
 * - Understand loop bounds and scaling implications
 * - Analyze cross-file/service architecture
 */
export const COMPLEX_RULES = new Set([
  "UNBOUNDED_QUERY",      // Need to distinguish Array.filter vs DB query
  "SILENT_ERROR",         // Need to trace if error is logged before catch
  "LOOPED_IO",            // Need to understand loop bounds and intent
  "MISSING_BATCHING",     // Need to understand if loop could grow unbounded
  "STATEFUL_SERVICE",     // Need to understand state sharing patterns
  "GLOBAL_MUTATION",      // Need to understand init vs runtime mutation
  "CHECK_THEN_ACT_RACE",  // Need to understand concurrency patterns
  "RETRY_STORM_RISK",     // Need to understand retry/backoff patterns
]);

/**
 * Rules that are simple pattern matches - fast model is sufficient.
 */
export const SIMPLE_RULES = new Set([
  "TEMPORARY_HACK",       // Just TODO/FIXME comments
  "CONSOLE_DEBUG",        // Just console.log statements
  "HARDCODED_SECRET",     // Pattern matching for secrets
  "HARDCODED_URL",        // Pattern matching for URLs
  "UNSAFE_EVAL",          // Direct eval() detection
  "BLOCKING_OPERATION",   // Direct sync API detection
]);
