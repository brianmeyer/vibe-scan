/**
 * LLM integration module for Vibe Scan.
 *
 * This file re-exports from the modular llm/ directory for backwards compatibility.
 * New code should import from "./llm" or "./llm/specific-module".
 */

export {
  // Types
  type LlmIssueKind,
  type LlmSeverity,
  type StaticFindingSummary,
  type LlmIssue,
  type LlmAnalysisResult,
  type ValidatedFinding,
  type ValidateFindingsInput,
  type ValidateFindingsResult,
  type ExecutiveSummaryInput,
  // Constants
  LLM_ISSUE_KIND_LABELS,
  // Functions
  analyzeSnippetWithLlm,
  generateExecutiveSummary,
  validateFindingsWithLlm,
  getTokenUsage,
  buildVibePrompt,
  severityToNumber,
  groupIssuesByKind,
} from "./llm/index";
