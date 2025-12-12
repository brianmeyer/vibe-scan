/**
 * Static analyzer for detecting "vibe-coded" or AI-generated prototype code
 * that may be risky for production (technical debt, scaling, reliability issues).
 *
 * This file re-exports from the modular structure for backwards compatibility.
 * New code should import from specific modules:
 * - ./detectors/patch - patch-based analysis
 * - ./detectors/file - full file analysis
 * - ./orchestration - PR analysis with config
 * - ./baseline - repository baseline scanning
 * - ./filtering - comment/string filtering
 */

// Re-export types
export type { Finding, Severity } from "./detectors/types";
export type { AnalysisOptions } from "./orchestration";
export type { BaselineAnalysisResult, BaselineAnalysisOptions } from "./baseline";

// Re-export detector functions
export { analyzePatch } from "./detectors/patch";
export { analyzeFileContent, CRITICAL_FULL_FILE_RULES } from "./detectors/file";

// Re-export orchestration
export { analyzePullRequestPatchesWithConfig, analyzePullRequestPatches } from "./orchestration";

// Re-export baseline
export { analyzeRepository, BASELINE_SCAN_RULES } from "./baseline";

// Re-export from other modules for convenience
export { RuleId, RuleLevel, isValidRuleId } from "./rules";
export { LoadedConfig, loadConfig, createDefaultConfig } from "../config/loader";
export { parseSuppressionDirectives, isSuppressed, SuppressionDirective } from "../config/suppression";
