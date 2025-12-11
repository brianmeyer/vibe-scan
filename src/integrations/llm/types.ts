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
