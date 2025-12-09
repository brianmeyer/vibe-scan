/**
 * Inline suppression directive parsing for Vibe Scan.
 *
 * Supports comment-based suppressions that work across languages:
 * - vibescan-ignore-file ALL|RULE_ID[,RULE_ID...]
 * - vibescan-ignore-line ALL|RULE_ID[,RULE_ID...]
 * - vibescan-ignore-next-line ALL|RULE_ID[,RULE_ID...]
 */

import { RuleId, isValidRuleId } from "./rules";

/**
 * The scope of a suppression directive.
 */
export type SuppressionScope = "file" | "line" | "next-line";

/**
 * A parsed suppression directive.
 */
export interface SuppressionDirective {
  /**
   * The scope of suppression:
   * - "file": Suppress for the entire file
   * - "line": Suppress for the current line only
   * - "next-line": Suppress for the next line only
   */
  scope: SuppressionScope;

  /**
   * If true, all rules are suppressed for this scope.
   */
  allRules: boolean;

  /**
   * Specific rule IDs to suppress (empty if allRules is true).
   */
  rules: RuleId[];

  /**
   * The 1-based line number where this directive appears.
   */
  line: number;
}

/**
 * Parse all suppression directives from source code.
 *
 * @param source - The source code to parse
 * @returns Array of parsed suppression directives
 */
export function parseSuppressionDirectives(source: string): SuppressionDirective[] {
  const directives: SuppressionDirective[] = [];
  // Handle both LF and CRLF line endings
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1; // 1-based

    // Create fresh regex per line to avoid global state issues
    const directiveRegex = /vibescan-ignore-(file|line|next-line)\s+([A-Z0-9_,\s]+|ALL)/gi;

    let match: RegExpExecArray | null;
    while ((match = directiveRegex.exec(line)) !== null) {
      const scopeStr = match[1].toLowerCase();
      const rulesStr = match[2].trim();

      // Map string to scope type
      let scope: SuppressionScope;
      if (scopeStr === "file") {
        scope = "file";
      } else if (scopeStr === "line") {
        scope = "line";
      } else if (scopeStr === "next-line") {
        scope = "next-line";
      } else {
        continue; // Unknown scope, skip
      }

      // Parse rules
      if (rulesStr.toUpperCase() === "ALL") {
        directives.push({
          scope,
          allRules: true,
          rules: [],
          line: lineNumber,
        });
      } else {
        // Split by comma or whitespace, filter to valid rule IDs
        const ruleTokens = rulesStr
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        const validRules: RuleId[] = [];
        for (const token of ruleTokens) {
          if (isValidRuleId(token)) {
            validRules.push(token);
          }
          // Silently ignore invalid rule IDs
        }

        if (validRules.length > 0) {
          directives.push({
            scope,
            allRules: false,
            rules: validRules,
            line: lineNumber,
          });
        }
      }
    }
  }

  return directives;
}

/**
 * Check if a specific rule is suppressed at a given line.
 *
 * @param ruleId - The rule ID to check
 * @param line - The 1-based line number where the finding would be reported
 * @param directives - The parsed suppression directives for the file
 * @returns true if the rule is suppressed at this line
 */
export function isSuppressed(
  ruleId: RuleId,
  line: number,
  directives: SuppressionDirective[]
): boolean {
  for (const directive of directives) {
    // Check if this directive suppresses the given rule
    const matchesRule = directive.allRules || directive.rules.includes(ruleId);
    if (!matchesRule) {
      continue;
    }

    switch (directive.scope) {
      case "file":
        // File-scope suppression applies everywhere
        return true;

      case "line":
        // Line-scope suppression applies only to the same line
        if (directive.line === line) {
          return true;
        }
        break;

      case "next-line":
        // Next-line suppression applies to the line after the directive
        if (directive.line + 1 === line) {
          return true;
        }
        break;
    }
  }

  return false;
}

/**
 * Get all file-scope suppressions from the directives.
 *
 * @param directives - The parsed suppression directives
 * @returns Array of rule IDs suppressed at file scope (or null if ALL is suppressed)
 */
export function getFileScopeSuppressions(
  directives: SuppressionDirective[]
): { allRules: boolean; rules: RuleId[] } {
  const rules = new Set<RuleId>();
  let allRules = false;

  for (const directive of directives) {
    if (directive.scope === "file") {
      if (directive.allRules) {
        allRules = true;
      } else {
        for (const rule of directive.rules) {
          rules.add(rule);
        }
      }
    }
  }

  return {
    allRules,
    rules: Array.from(rules),
  };
}

/**
 * Check if any rule is suppressed at the file level.
 *
 * @param directives - The parsed suppression directives
 * @returns true if there are any file-scope suppressions
 */
export function hasFileScopeSuppressions(
  directives: SuppressionDirective[]
): boolean {
  return directives.some((d) => d.scope === "file");
}

/**
 * Filter findings based on suppression directives.
 * This is a convenience function for use in analyzers.
 *
 * @param findings - Array of findings with ruleId and line properties
 * @param directives - The parsed suppression directives
 * @returns Filtered array with suppressed findings removed
 */
export function filterSuppressedFindings<
  T extends { kind: string; line?: number }
>(findings: T[], directives: SuppressionDirective[]): T[] {
  return findings.filter((finding) => {
    // If no line number, can't suppress by line (only file-scope would work)
    const line = finding.line ?? 0;

    // Check if this finding's rule is suppressed
    if (isValidRuleId(finding.kind)) {
      return !isSuppressed(finding.kind, line, directives);
    }

    // For findings with non-standard kinds, only file-scope ALL suppression applies
    const fileSuppressions = getFileScopeSuppressions(directives);
    return !fileSuppressions.allRules;
  });
}
