/**
 * Filtering utilities for removing false positives in comments and strings.
 */

import { IgnoredRange } from "./ast";
import { Finding } from "./detectors/types";

/**
 * Check if a regex finding should be filtered due to being in a comment or string literal.
 * NOTE: This is only applied to regex findings - AST findings are already scope-aware.
 *
 * @param finding - The finding to check
 * @param ignoredRanges - Array of ignored ranges (comments and strings)
 * @returns true if the finding should be filtered out
 */
export function isRegexFindingInIgnoredContext(
  finding: Finding,
  ignoredRanges: IgnoredRange[] | null
): boolean {
  if (!ignoredRanges || !finding.line) return false;

  // TEMPORARY_HACK should NOT be filtered when in comments (it's looking for TODO/FIXME comments)
  // but SHOULD be filtered when in string literals
  const shouldFilterComments = finding.kind !== "TEMPORARY_HACK";

  for (const range of ignoredRanges) {
    // Skip comment ranges for TEMPORARY_HACK
    if (range.type === "comment" && !shouldFilterComments) {
      continue;
    }

    // Check if finding line falls within the range
    if (finding.line >= range.startLine && finding.line <= range.endLine) {
      return true;
    }
  }
  return false;
}

/**
 * Filter an array of findings to remove those in ignored contexts.
 *
 * @param findings - Array of findings to filter
 * @param ignoredRanges - Array of ignored ranges (comments and strings)
 * @returns Filtered array of findings
 */
export function filterFindingsInIgnoredContext(
  findings: Finding[],
  ignoredRanges: IgnoredRange[] | null
): Finding[] {
  if (!ignoredRanges) return findings;
  return findings.filter((f) => !isRegexFindingInIgnoredContext(f, ignoredRanges));
}
