/**
 * PR analysis orchestration - coordinates detectors, AST, filtering, and config.
 */

import { RuleId, isValidRuleId } from "./rules";
import { LoadedConfig, createDefaultConfig } from "../config/loader";
import { parseSuppressionDirectives, isSuppressed } from "../config/suppression";
import {
  analyzeWithAST,
  canAnalyzeWithAST,
  convertASTFindingsToFindings,
  parseChangedLinesFromPatch,
  mergeFindings,
  getIgnoredRanges,
} from "./ast";
import { isCodeFile, extractAddedLinesFromPatch } from "./helpers";
import { analyzePatch } from "./detectors/patch";
import { analyzeFileContent } from "./detectors/file";
import { Finding } from "./detectors/types";
import { filterFindingsInIgnoredContext } from "./filtering";

/**
 * Options for config-aware analysis.
 */
export interface AnalysisOptions {
  /**
   * The loaded configuration. If not provided, uses defaults.
   */
  config?: LoadedConfig;
  /**
   * Optional map of file paths to their full content.
   * When provided, enables hybrid AST + regex analysis for supported languages.
   */
  fileContents?: Map<string, string>;
}

/**
 * Analyze all PR files with config and suppression support.
 *
 * This is the preferred entry point for analysis that respects:
 * - .vibecheck.yml configuration
 * - File ignore patterns
 * - Rule enable/disable settings
 * - Per-path rule overrides
 * - Inline suppression directives
 * - Hybrid AST + regex analysis (when fileContents provided)
 * - Full file scan for critical issues (Phase 1)
 *
 * @param files - Array of files with filename and patch content
 * @param options - Analysis options including config and optional file contents
 * @returns Array of findings that passed config and suppression filters
 */
export function analyzePullRequestPatchesWithConfig(
  files: { filename: string; patch?: string | null }[],
  options: AnalysisOptions = {}
): Finding[] {
  const config = options.config ?? createDefaultConfig();
  const fileContents = options.fileContents;
  const allFindings: Finding[] = [];

  for (const file of files) {
    // Skip files without patches
    if (!file.patch) {
      continue;
    }

    // Only analyze code files
    if (!isCodeFile(file.filename)) {
      continue;
    }

    // Check if file is ignored by config
    if (config.isFileIgnored(file.filename)) {
      continue;
    }

    // Get raw findings - use hybrid analysis when file content is available
    let rawFindings: Finding[];
    const content = fileContents?.get(file.filename);

    // Get ignored ranges (comments and strings) for filtering regex false positives
    const ignoredRanges = content ? getIgnoredRanges(content, file.filename) : null;

    if (content && canAnalyzeWithAST(file.filename)) {
      // Hybrid AST + regex analysis
      const changedLines = parseChangedLinesFromPatch(file.patch);
      const astResult = analyzeWithAST(content, file.filename, { changedLines });

      if (astResult && astResult.parseSuccess) {
        // AST analysis succeeded - merge with filtered regex findings
        const astFindings = convertASTFindingsToFindings(astResult.findings, file.filename);
        const regexFindings = analyzePatch(file.filename, file.patch);

        // Filter regex findings to remove false positives in comments/strings
        // AST findings are already scope-aware and should NOT be filtered
        const filteredRegexFindings = filterFindingsInIgnoredContext(regexFindings, ignoredRanges);

        rawFindings = mergeFindings(astFindings, filteredRegexFindings);
        console.log(
          `[Analyzer] Hybrid analysis for ${file.filename}: ${astFindings.length} AST + ${filteredRegexFindings.length} regex (${regexFindings.length - filteredRegexFindings.length} filtered) -> ${rawFindings.length} merged`
        );
      } else {
        // AST parsing failed - fall back to regex with filtering
        const regexFindings = analyzePatch(file.filename, file.patch);
        rawFindings = filterFindingsInIgnoredContext(regexFindings, ignoredRanges);
        console.log(
          `[Analyzer] AST parse failed for ${file.filename}, using regex only: ${rawFindings.length} findings (${regexFindings.length - rawFindings.length} filtered)`
        );
      }
    } else {
      // No content or unsupported language - regex only with filtering if content available
      const regexFindings = analyzePatch(file.filename, file.patch);
      rawFindings = filterFindingsInIgnoredContext(regexFindings, ignoredRanges);
    }

    // ========================================================================
    // PHASE 1: Full file scan for critical issues
    // ========================================================================
    let fullFileFindings: Finding[] = [];
    if (content) {
      fullFileFindings = analyzeFileContent(file.filename, content);

      // Deduplicate: remove full file findings that are already in patch findings
      const patchFindingKeys = new Set(
        rawFindings.map((f) => `${f.file}:${f.line}:${f.kind}`)
      );
      fullFileFindings = fullFileFindings.filter(
        (f) => !patchFindingKeys.has(`${f.file}:${f.line}:${f.kind}`)
      );

      // Merge: add full file findings to raw findings
      rawFindings = [...rawFindings, ...fullFileFindings];

      console.log(
        `[Analyzer] Full file scan for ${file.filename}: ${fullFileFindings.length} critical + ${rawFindings.length - fullFileFindings.length} patch -> ${rawFindings.length} total`
      );
    }

    // Parse suppression directives from the patch content
    const patchContent = extractAddedLinesFromPatch(file.patch);
    const suppressions = parseSuppressionDirectives(patchContent);

    // Check if file is in prototype zone
    const isInPrototypeZone = config.isPrototypeZone(file.filename);

    // Filter and enrich findings
    for (const finding of rawFindings) {
      // Check if the rule is enabled for this file
      if (isValidRuleId(finding.kind)) {
        const ruleConfig = config.getRuleConfig(finding.kind as RuleId, file.filename);

        // Skip if rule is disabled or level is "off"
        if (!ruleConfig.enabled || ruleConfig.level === "off") {
          continue;
        }

        // Check inline suppressions
        if (finding.line && isSuppressed(finding.kind as RuleId, finding.line, suppressions)) {
          continue;
        }

        // Enrich finding with level and prototype zone info
        allFindings.push({
          ...finding,
          level: ruleConfig.level,
          isPrototypeZone: isInPrototypeZone,
        });
      } else {
        // For non-standard rule kinds, only apply file-scope ALL suppression
        const hasAllSuppression = suppressions.some((s) => s.scope === "file" && s.allRules);
        if (!hasAllSuppression) {
          allFindings.push({
            ...finding,
            isPrototypeZone: isInPrototypeZone,
          });
        }
      }
    }
  }

  return allFindings;
}

/**
 * Analyze all PR files and return aggregated findings.
 * Only analyzes files that look like code (based on extension).
 *
 * @deprecated Use analyzePullRequestPatchesWithConfig for config-aware analysis.
 */
export function analyzePullRequestPatches(files: { filename: string; patch?: string | null }[]): Finding[] {
  const allFindings: Finding[] = [];

  for (const file of files) {
    // Skip files without patches
    if (!file.patch) {
      continue;
    }

    // Only analyze code files
    if (!isCodeFile(file.filename)) {
      continue;
    }

    const fileFindings = analyzePatch(file.filename, file.patch);
    allFindings.push(...fileFindings);
  }

  return allFindings;
}
