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

// Re-export types
export type {
  LlmIssueKind,
  LlmSeverity,
  StaticFindingSummary,
  LlmIssue,
  LlmAnalysisResult,
  ValidatedFinding,
  ValidateFindingsInput,
  ValidateFindingsResult,
  ExecutiveSummaryInput,
} from "./types";

// Re-export constants
export {
  LLM_ISSUE_KIND_LABELS,
  MODEL_FAST,
  MODEL_REASONING,
  MODEL_BALANCED,
  COMPLEX_RULES,
  SIMPLE_RULES,
} from "./types";

// Re-export main functions
export { analyzeSnippetWithLlm } from "./analysis";
export { generateExecutiveSummary } from "./summary";
export { validateFindingsWithLlm } from "./validation";
export { getTokenUsage } from "./quota";
export { buildVibePrompt } from "./prompts";

// Re-export utilities
export { severityToNumber, groupIssuesByKind } from "./utils";
