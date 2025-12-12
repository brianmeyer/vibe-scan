/**
 * JSON parsing, repair, and validation utilities for LLM responses.
 */

import {
  LlmAnalysisResult,
  LlmIssue,
  LlmIssueKind,
  LlmSeverity,
  VALID_KINDS,
  VALID_SEVERITIES,
} from "./types";

/**
 * Attempt to repair a truncated JSON response from the LLM.
 * Handles cases where the response was cut off mid-JSON due to token limits.
 *
 * @param content - The potentially truncated JSON string
 * @returns Repaired JSON string or null if repair is not possible
 */
export function attemptJsonRepair(content: string): string | null {
  // Only attempt repair if it looks like a truncated JSON object with issues array
  if (!content.includes('"issues"') || !content.includes('[')) {
    return null;
  }

  // Find the start of the JSON object
  const jsonStart = content.indexOf('{');
  if (jsonStart === -1) {
    return null;
  }

  let jsonStr = content.slice(jsonStart);

  // Try to find the last complete issue object by finding the last complete "}"
  // that appears to end an issue object (followed by comma or appears after "severity")
  const issuesMatch = jsonStr.match(/"issues"\s*:\s*\[/);
  if (!issuesMatch) {
    return null;
  }

  // Find all complete issue objects (those that have a closing brace after severity)
  // Look for pattern: "severity": "..." } which ends an issue
  const severityPattern = /"severity"\s*:\s*"(?:low|medium|high)"\s*\}/g;
  let lastCompleteIssue = -1;
  let match;

  while ((match = severityPattern.exec(jsonStr)) !== null) {
    lastCompleteIssue = match.index + match[0].length;
  }

  if (lastCompleteIssue === -1) {
    // No complete issues found, return minimal valid structure
    return '{"issues": [], "architectureSummary": null}';
  }

  // Truncate at the last complete issue and close the structure
  jsonStr = jsonStr.slice(0, lastCompleteIssue);

  // Close the issues array and the outer object
  jsonStr += ']}';

  return jsonStr;
}

/**
 * Validate and normalize the parsed LLM response.
 */
export function validateAndNormalize(parsed: unknown, defaultFile: string): LlmAnalysisResult {
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
