/**
 * Hybrid AST + Regex Analysis System
 *
 * This module provides a unified interface for AST-based analysis that:
 * 1. Automatically selects the right analyzer based on file extension
 * 2. Falls back to regex analysis for unsupported languages
 * 3. Combines AST findings with regex findings for comprehensive coverage
 *
 * Supported languages:
 * - TypeScript/JavaScript: ts-morph (full type-aware analysis)
 * - Python: tree-sitter (fast, fault-tolerant parsing)
 * - Others: Falls back to regex-based analysis
 */

import { TypeScriptAnalyzer, typescriptAnalyzer } from "./typescript";
import { PythonAnalyzer, pythonAnalyzer } from "./python";
import {
  LanguageAnalyzer,
  ASTAnalysisResult,
  ASTFinding,
  SupportedLanguage,
  detectLanguage,
  isLanguageSupported,
  ASTAnalysisOptions,
  CodeContext,
} from "./types";
import { Finding, Severity } from "../analyzer";
import { RuleId } from "../rules";

// Re-export types
export {
  ASTAnalysisResult,
  ASTFinding,
  SupportedLanguage,
  CodeContext,
  ASTAnalysisOptions,
  detectLanguage,
  isLanguageSupported,
};

// ============================================================================
// Unified AST Analyzer
// ============================================================================

/**
 * Registry of language-specific analyzers.
 */
const analyzers = new Map<SupportedLanguage, LanguageAnalyzer>();
analyzers.set("typescript", typescriptAnalyzer);
analyzers.set("javascript", typescriptAnalyzer); // ts-morph handles JS too
analyzers.set("python", pythonAnalyzer);

/**
 * Analyze a file using the appropriate AST analyzer.
 *
 * @param content - The full source code content
 * @param filePath - The file path (used for language detection)
 * @param options - Analysis options
 * @returns Analysis result, or null if language not supported
 */
export function analyzeWithAST(
  content: string,
  filePath: string,
  options: ASTAnalysisOptions = {}
): ASTAnalysisResult | null {
  const language = detectLanguage(filePath);

  if (!isLanguageSupported(language)) {
    return null;
  }

  const analyzer = analyzers.get(language);
  if (!analyzer) {
    return null;
  }

  return analyzer.analyze(content, filePath, options.changedLines);
}

/**
 * Check if a file can be analyzed with AST.
 */
export function canAnalyzeWithAST(filePath: string): boolean {
  const language = detectLanguage(filePath);
  return isLanguageSupported(language) && analyzers.has(language);
}

/**
 * Convert AST findings to the standard Finding format used by the rest of the system.
 *
 * @param astFindings - Findings from AST analysis
 * @param filePath - The file path
 * @returns Standard Finding objects
 */
export function convertASTFindingsToFindings(astFindings: ASTFinding[], filePath: string): Finding[] {
  return astFindings.map((astFinding) => ({
    file: filePath,
    line: astFinding.line,
    severity: astFinding.severity,
    kind: astFinding.ruleId,
    message: astFinding.message,
    snippet: astFinding.snippet,
    // Preserve AST-specific metadata in a way that's compatible with Finding
  }));
}

/**
 * Parse changed line numbers from a unified diff patch.
 *
 * @param patch - Unified diff patch content
 * @returns Set of line numbers that were added/changed
 */
export function parseChangedLinesFromPatch(patch: string): Set<number> {
  const changedLines = new Set<number>();
  const lines = patch.split("\n");
  let currentLine = 0;

  for (const line of lines) {
    // Parse hunk header: @@ -a,b +c,d @@
    const hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Skip diff metadata
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ")) {
      continue;
    }

    // Added lines
    if (line.startsWith("+")) {
      changedLines.add(currentLine);
      currentLine++;
    }
    // Removed lines don't increment the line counter
    else if (line.startsWith("-")) {
      continue;
    }
    // Context lines
    else {
      currentLine++;
    }
  }

  return changedLines;
}

// ============================================================================
// Hybrid Analysis (AST + Regex)
// ============================================================================

/**
 * Rules that benefit significantly from AST analysis.
 * For these rules, we prefer AST findings over regex findings.
 */
const AST_PREFERRED_RULES: Set<RuleId> = new Set([
  "UNSAFE_IO",
  "LOOPED_IO",
  "UNBOUNDED_QUERY",
  "GLOBAL_MUTATION",
  "SILENT_ERROR",
  "CHECK_THEN_ACT_RACE",
  "BLOCKING_OPERATION",
  "SHARED_FILE_WRITE",
  "ASYNC_MISUSE",
]);

/**
 * Rules where regex is sufficient and AST doesn't add much value.
 */
const REGEX_SUFFICIENT_RULES: Set<RuleId> = new Set([
  "TEMPORARY_HACK",
  "CONSOLE_DEBUG",
  "HARDCODED_SECRET",
  "DATA_SHAPE_ASSUMPTION",
]);

/**
 * Merge AST findings with regex findings, preferring AST for certain rules.
 *
 * Strategy:
 * 1. For AST_PREFERRED_RULES: Use AST findings, discard regex findings
 * 2. For REGEX_SUFFICIENT_RULES: Use regex findings
 * 3. For other rules: Include both, deduplicated by line number
 *
 * @param astFindings - Findings from AST analysis
 * @param regexFindings - Findings from regex analysis
 * @returns Merged findings
 */
export function mergeFindings(astFindings: Finding[], regexFindings: Finding[]): Finding[] {
  const result: Finding[] = [];
  const seenKeys = new Set<string>();

  // Helper to create a deduplication key
  const makeKey = (finding: Finding) => `${finding.file}:${finding.line}:${finding.kind}`;

  // First, add all AST findings for preferred rules
  for (const finding of astFindings) {
    if (AST_PREFERRED_RULES.has(finding.kind as RuleId)) {
      const key = makeKey(finding);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        result.push(finding);
      }
    }
  }

  // Then, add regex findings for rules where regex is sufficient
  // or for rules where AST didn't find anything
  for (const finding of regexFindings) {
    const key = makeKey(finding);

    // Skip if we already have this from AST
    if (seenKeys.has(key)) continue;

    // For AST-preferred rules, only add if AST analysis wasn't available
    // (we'll check this by seeing if there were any AST findings at all)
    if (AST_PREFERRED_RULES.has(finding.kind as RuleId)) {
      // Skip regex findings for AST-preferred rules when we have AST findings
      const hasASTFindingsForFile = astFindings.some((f) => f.file === finding.file);
      if (hasASTFindingsForFile) continue;
    }

    seenKeys.add(key);
    result.push(finding);
  }

  // Finally, add any remaining AST findings not in preferred rules
  for (const finding of astFindings) {
    if (!AST_PREFERRED_RULES.has(finding.kind as RuleId)) {
      const key = makeKey(finding);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        result.push(finding);
      }
    }
  }

  return result;
}

/**
 * Perform hybrid analysis on a file, using AST when available and falling back to regex.
 *
 * @param content - Full file content (required for AST analysis)
 * @param patch - Diff patch content (used for regex analysis and line filtering)
 * @param filePath - File path
 * @param regexAnalyze - Function to perform regex analysis
 * @returns Combined findings from both methods
 */
export async function analyzeHybrid(
  content: string | null,
  patch: string,
  filePath: string,
  regexAnalyze: (file: string, patch: string) => Finding[]
): Promise<Finding[]> {
  const regexFindings = regexAnalyze(filePath, patch);

  // If we don't have full content or can't use AST, return regex findings
  if (!content || !canAnalyzeWithAST(filePath)) {
    return regexFindings;
  }

  // Parse changed lines from patch
  const changedLines = parseChangedLinesFromPatch(patch);

  // Run AST analysis
  const astResult = analyzeWithAST(content, filePath, { changedLines });

  // If AST parsing failed, fall back to regex
  if (!astResult || !astResult.parseSuccess) {
    return regexFindings;
  }

  // Convert AST findings to standard format
  const astFindings = convertASTFindingsToFindings(astResult.findings, filePath);

  // Merge findings, preferring AST for certain rules
  return mergeFindings(astFindings, regexFindings);
}

// ============================================================================
// Statistics and Diagnostics
// ============================================================================

/**
 * Get statistics about AST analysis support.
 */
export function getASTSupportStats(): {
  supportedLanguages: SupportedLanguage[];
  astPreferredRules: RuleId[];
  regexSufficientRules: RuleId[];
} {
  return {
    supportedLanguages: Array.from(analyzers.keys()) as SupportedLanguage[],
    astPreferredRules: Array.from(AST_PREFERRED_RULES),
    regexSufficientRules: Array.from(REGEX_SUFFICIENT_RULES),
  };
}
