/**
 * Shared types for AST-based analysis.
 *
 * This module defines the common interfaces used by both the TypeScript/JavaScript
 * analyzer (ts-morph) and the Python analyzer (tree-sitter).
 */

import { RuleId } from "../rules";
import { Severity } from "../analyzer";

/**
 * Context about a specific code location for more accurate detection.
 */
export interface CodeContext {
  /** Is this code inside a try/catch or try/except block? */
  isInTryCatch: boolean;
  /** Is this code inside a loop (for, while, forEach, etc.)? */
  isInLoop: boolean;
  /** Is this code inside an async function? */
  isInAsyncFunction: boolean;
  /** Is this code at module/file scope (not inside a function)? */
  isModuleScope: boolean;
  /** Is this code inside a route handler (Express, FastAPI, etc.)? */
  isInRouteHandler: boolean;
  /** Parent function name if inside a function */
  parentFunctionName?: string;
  /** Enclosing class name if inside a class */
  enclosingClassName?: string;
}

/**
 * An AST-based finding with rich context.
 */
export interface ASTFinding {
  /** The rule that was triggered */
  ruleId: RuleId;
  /** Line number in the source file (1-based) */
  line: number;
  /** Column number (1-based, optional) */
  column?: number;
  /** End line for multi-line findings */
  endLine?: number;
  /** Severity of the finding */
  severity: Severity;
  /** Human-readable message */
  message: string;
  /** Code snippet that triggered the finding */
  snippet: string;
  /** Additional context about the code location */
  context: CodeContext;
  /** Confidence level (AST analysis is generally higher than regex) */
  confidence: "high" | "medium" | "low";
}

/**
 * Result of analyzing a single file with AST.
 */
export interface ASTAnalysisResult {
  /** The file path that was analyzed */
  filePath: string;
  /** The language detected */
  language: SupportedLanguage;
  /** Whether AST parsing succeeded */
  parseSuccess: boolean;
  /** Parse error message if parsing failed */
  parseError?: string;
  /** Findings from AST analysis */
  findings: ASTFinding[];
  /** Time taken for analysis in milliseconds */
  analysisTimeMs: number;
}

/**
 * Languages supported by the AST analyzer.
 */
export type SupportedLanguage = "typescript" | "javascript" | "python" | "go" | "ruby" | "unknown";

/**
 * Detect the language from a file path.
 */
export function detectLanguage(filePath: string): SupportedLanguage {
  const ext = filePath.toLowerCase().split(".").pop();

  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
    case "pyw":
      return "python";
    case "go":
      return "go";
    case "rb":
    case "rake":
    case "ru":
      return "ruby";
    default:
      return "unknown";
  }
}

/**
 * Check if a language is supported for AST analysis.
 */
export function isLanguageSupported(language: SupportedLanguage): boolean {
  return language !== "unknown";
}

/**
 * Interface that all language-specific AST analyzers must implement.
 */
export interface LanguageAnalyzer {
  /** The language this analyzer handles */
  language: SupportedLanguage;

  /**
   * Analyze a file's content and return findings.
   *
   * @param content - The full source code content
   * @param filePath - The file path (used for language detection and reporting)
   * @param changedLines - Optional set of line numbers that were changed (for filtering)
   * @returns Analysis result with findings
   */
  analyze(content: string, filePath: string, changedLines?: Set<number>): ASTAnalysisResult;

  /**
   * Check if this analyzer can handle the given file.
   */
  canAnalyze(filePath: string): boolean;

  /**
   * Get ranges in the source code that should be ignored for regex matching.
   * This includes comments and string literals.
   *
   * @param content - The full source code content
   * @returns Array of ignored ranges, or null if parsing fails
   */
  getIgnoredRanges(content: string): IgnoredRange[] | null;
}

/**
 * Options for AST analysis.
 */
export interface ASTAnalysisOptions {
  /** Only report findings on these line numbers (from diff) */
  changedLines?: Set<number>;
  /** Maximum time to spend on analysis (ms) */
  timeoutMs?: number;
  /** Whether to include low-confidence findings */
  includeLowConfidence?: boolean;
}

/**
 * Represents a range in the source code that should be ignored for regex matching.
 * This includes comments and string literals where code patterns are not executable.
 */
export interface IgnoredRange {
  /** Start line (1-based) */
  startLine: number;
  /** End line (1-based, inclusive) */
  endLine: number;
  /** Start column on start line (1-based) */
  startColumn: number;
  /** End column on end line (1-based) */
  endColumn: number;
  /** Type of ignored range */
  type: "comment" | "string";
}

/**
 * Check if a line/column position falls within any ignored range.
 */
export function isInIgnoredRange(
  line: number,
  column: number,
  ignoredRanges: IgnoredRange[]
): boolean {
  for (const range of ignoredRanges) {
    // Single-line range
    if (range.startLine === range.endLine) {
      if (line === range.startLine && column >= range.startColumn && column <= range.endColumn) {
        return true;
      }
    }
    // Multi-line range
    else {
      if (line > range.startLine && line < range.endLine) {
        return true;
      }
      if (line === range.startLine && column >= range.startColumn) {
        return true;
      }
      if (line === range.endLine && column <= range.endColumn) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if an entire line falls within any ignored range (for line-based regex matching).
 * Returns true if any part of the line is NOT in an ignored range.
 */
export function isLineFullyIgnored(line: number, ignoredRanges: IgnoredRange[]): boolean {
  for (const range of ignoredRanges) {
    // Check if this line is fully contained in the range
    if (range.startLine <= line && range.endLine >= line) {
      // For single-line ranges, we can't assume the whole line is ignored
      if (range.startLine === range.endLine) {
        continue; // Partial line comment, not fully ignored
      }
      // For multi-line ranges, middle lines are fully ignored
      if (line > range.startLine && line < range.endLine) {
        return true;
      }
    }
  }
  return false;
}
