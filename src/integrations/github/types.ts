/**
 * Shared types and constants for GitHub integration.
 */

import { Finding } from "../../analysis/analyzer";
import { ValidatedFinding } from "../llm";

// ============================================================================
// File Types
// ============================================================================

export interface PrFilePatch {
  filename: string;
  patch?: string | null;
}

export interface LlmCandidate {
  file: string;
  patch: string;
  language?: string;
}

// ============================================================================
// Architecture Risk Types
// ============================================================================

export interface ArchIssue {
  file: string;
  line?: number;
  snippet: string;
  kind: string;
}

export interface ArchitectureRiskSummary {
  scaling: { count: number; topIssues: ArchIssue[] };
  concurrency: { count: number; topIssues: ArchIssue[] };
  errorHandling: { count: number; topIssues: ArchIssue[] };
  dataIntegrity: { count: number; topIssues: ArchIssue[] };
  security: { count: number; topIssues: ArchIssue[] };
}

// ============================================================================
// Grouped Findings Types
// ============================================================================

export interface GroupedFinding {
  kind: string;
  count: number;
  severity: "high" | "medium" | "low";
  description: string;
  locations: { file: string; line?: number }[];
}

export interface GroupedValidatedFinding {
  kind: string;
  count: number;
  severity: "high" | "medium" | "low";
  description: string;
  avgConfidence: number;
  locations: { file: string; line?: number; confidence: number }[];
  filteredCount: number;
}

// ============================================================================
// API Types
// ============================================================================

export interface ApiAnalysisResult {
  success: boolean;
  vibeScore: number;
  vibeLabel: string;
  findings: {
    total: number;
    high: number;
    medium: number;
    low: number;
    filtered: number;
  };
  details: Array<{
    ruleId: string;
    file: string;
    line: number | null;
    severity: string;
    message: string;
    confidence?: number;
    likelyFalsePositive?: boolean;
  }>;
  executiveSummary?: string;
  error?: string;
}

// ============================================================================
// Baseline Types
// ============================================================================

export interface BaselineScanParams {
  installationId: number;
  owner: string;
  repoName: string;
  repoFullName: string;
}

export interface BaselineIssueParams {
  vibeScore: number;
  vibeLabel: string;
  findings: Finding[];
  validatedFindings?: ValidatedFinding[] | null;
  filteredCount?: number;
  filesAnalyzed: number;
  filesSkipped: number;
  truncated: boolean;
  totalCodeFiles: number;
}

// ============================================================================
// Constants - File Extensions
// ============================================================================

export const MAX_FILE_SIZE_BYTES = 50 * 1024;

export const CODE_FILE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyw",
  ".go",
  ".rb", ".rake",
  ".java", ".kt", ".scala",
  ".cs", ".fs",
  ".rs",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".php",
  ".swift",
  ".vue", ".svelte",
]);

// ============================================================================
// Constants - Architecture Risk Categories
// ============================================================================

export const SCALING_KINDS = new Set([
  "UNBOUNDED_QUERY",
  "UNBOUNDED_COLLECTION_PROCESSING",
  "MISSING_BATCHING",
  "NO_CACHING",
  "MEMORY_RISK",
  "LOOPED_IO",
  "BLOCKING_OPERATION",
  "STATEFUL_SERVICE",
]);

export const CONCURRENCY_KINDS = new Set([
  "SHARED_FILE_WRITE",
  "RETRY_STORM_RISK",
  "BUSY_WAIT_OR_TIGHT_LOOP",
  "CHECK_THEN_ACT_RACE",
  "GLOBAL_MUTATION",
  "CONCURRENCY_RISK",
]);

export const ERROR_HANDLING_KINDS = new Set([
  "UNSAFE_IO",
  "SILENT_ERROR",
  "MISSING_ERROR_HANDLING",
  "ASYNC_MISUSE",
]);

export const DATA_INTEGRITY_KINDS = new Set([
  "UNVALIDATED_INPUT",
  "DATA_SHAPE_ASSUMPTION",
  "MIXED_RESPONSE_SHAPES",
  "HIDDEN_ASSUMPTIONS",
  "HARDCODED_SECRET",
]);

export const SECURITY_KINDS = new Set([
  "UNSAFE_EVAL",
  "HARDCODED_URL",
  "PROTOTYPE_INFRA",
]);

export const MAX_TOP_ISSUES_PER_CATEGORY = 2;

// ============================================================================
// Constants - Rule Descriptions
// ============================================================================

export const RULE_DESCRIPTIONS: Record<string, string> = {
  UNBOUNDED_QUERY: "Query without limit",
  LOOPED_IO: "I/O call in loop (N+1)",
  MEMORY_RISK: "Loading large data into memory",
  GLOBAL_MUTATION: "Mutable global state",
  CHECK_THEN_ACT_RACE: "Race condition (check-then-act)",
  SILENT_ERROR: "Error swallowed silently",
  UNSAFE_IO: "Network call without error handling",
  STATEFUL_SERVICE: "In-memory state (breaks scaling)",
  PROTOTYPE_INFRA: "Non-production infrastructure",
  HARDCODED_SECRET: "Hardcoded credential",
  UNSAFE_EVAL: "Dynamic code execution",
  HARDCODED_URL: "Hardcoded URL/localhost",
  BLOCKING_OPERATION: "Blocking synchronous operation",
  SCALING_RISK: "Scaling concern",
  CONCURRENCY_RISK: "Concurrency issue",
  RESILIENCE_GAP: "Missing fault tolerance",
  OBSERVABILITY_GAP: "Missing observability",
  DATA_CONTRACT_RISK: "Data validation issue",
  ENVIRONMENT_ASSUMPTION: "Environment-specific code",
};

// ============================================================================
// Constants - Baseline Limits
// ============================================================================

export const BASELINE_MAX_FILE_SIZE = 100 * 1024;
export const BASELINE_MAX_FILES = 200;
export const BASELINE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export const CONFIG_FILE_NAME = ".vibecheck.yml";
