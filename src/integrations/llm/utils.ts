/**
 * LLM utility functions for consumers.
 */

import { LlmSeverity, LlmIssue, LlmIssueKind } from "./types";

/**
 * Convert LlmSeverity to a numeric value for sorting/filtering.
 */
export function severityToNumber(severity: LlmSeverity): 1 | 2 | 3 {
  switch (severity) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
  }
}

/**
 * Group issues by their kind for display purposes.
 */
export function groupIssuesByKind(issues: LlmIssue[]): Map<LlmIssueKind, LlmIssue[]> {
  const grouped = new Map<LlmIssueKind, LlmIssue[]>();

  for (const issue of issues) {
    const existing = grouped.get(issue.kind) || [];
    existing.push(issue);
    grouped.set(issue.kind, existing);
  }

  return grouped;
}
