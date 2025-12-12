/**
 * Full file content analysis for critical issues.
 */

import {
  MAX_FINDINGS_PER_FILE,
  STATEFUL_SERVICE_PATTERNS,
  PROTOTYPE_INFRA_PATTERNS,
  SECRET_PATTERNS,
  UNSAFE_EVAL_PATTERNS,
  matchesAnyPattern,
} from "../patterns";

import { isTestFile } from "../helpers";
import { Finding } from "./types";

/**
 * Critical rules that should be checked against the entire file,
 * not just the changed lines.
 */
export const CRITICAL_FULL_FILE_RULES = new Set<string>([
  "STATEFUL_SERVICE",
  "PROTOTYPE_INFRA",
  "HARDCODED_SECRET",
  "UNSAFE_EVAL",
  "GLOBAL_MUTATION",
]);

/**
 * Analyze entire file content for critical issues.
 * Used for detecting architectural problems that exist anywhere in a touched file,
 * not just in the changed lines.
 *
 * @param filename - The file path
 * @param content - The full file content
 * @param options - Optional: specific rules to check (defaults to CRITICAL_FULL_FILE_RULES)
 * @returns Array of findings for critical issues found anywhere in the file
 */
export function analyzeFileContent(
  filename: string,
  content: string,
  options?: { rulesToCheck?: Set<string> }
): Finding[] {
  const rulesToCheck = options?.rulesToCheck ?? CRITICAL_FULL_FILE_RULES;
  const findings: Finding[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // STATEFUL_SERVICE detection
    if (rulesToCheck.has("STATEFUL_SERVICE")) {
      if (matchesAnyPattern(line, STATEFUL_SERVICE_PATTERNS)) {
        findings.push({
          kind: "STATEFUL_SERVICE",
          file: filename,
          line: lineNumber,
          severity: "high",
          message: "In-memory state detected - breaks horizontal scaling",
          snippet: line.trim(),
        });
      }
    }

    // PROTOTYPE_INFRA detection
    if (rulesToCheck.has("PROTOTYPE_INFRA")) {
      if (matchesAnyPattern(line, PROTOTYPE_INFRA_PATTERNS)) {
        findings.push({
          kind: "PROTOTYPE_INFRA",
          file: filename,
          line: lineNumber,
          severity: "high",
          message: "Prototype infrastructure detected - won't scale in production",
          snippet: line.trim(),
        });
      }
    }

    // HARDCODED_SECRET detection
    if (rulesToCheck.has("HARDCODED_SECRET")) {
      if (matchesAnyPattern(line, SECRET_PATTERNS)) {
        // Don't flag in test files
        if (!isTestFile(filename)) {
          findings.push({
            kind: "HARDCODED_SECRET",
            file: filename,
            line: lineNumber,
            severity: "high",
            message: "Possible hardcoded secret or credential",
            snippet: line.trim().substring(0, 80) + (line.length > 80 ? "..." : ""),
          });
        }
      }
    }

    // UNSAFE_EVAL detection
    if (rulesToCheck.has("UNSAFE_EVAL")) {
      if (matchesAnyPattern(line, UNSAFE_EVAL_PATTERNS)) {
        findings.push({
          kind: "UNSAFE_EVAL",
          file: filename,
          line: lineNumber,
          severity: "high",
          message: "Dangerous code evaluation detected - security risk",
          snippet: line.trim(),
        });
      }
    }

    // GLOBAL_MUTATION detection (simplified - AST check is more accurate)
    if (rulesToCheck.has("GLOBAL_MUTATION")) {
      // Check for module-level let/var declarations (not inside functions/classes)
      if (/^(let|var)\s+\w+\s*=\s*(new\s+(Map|Set|Array)|{|\[)/.test(line)) {
        findings.push({
          kind: "GLOBAL_MUTATION",
          file: filename,
          line: lineNumber,
          severity: "medium",
          message: "Module-level mutable state - may cause bugs with concurrent requests",
          snippet: line.trim(),
        });
      }
    }
  }

  // Limit findings per file
  return findings.slice(0, MAX_FINDINGS_PER_FILE);
}
