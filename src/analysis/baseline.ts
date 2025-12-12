/**
 * Baseline repository scanning for initial Vibe Score assessment.
 */

import { RuleId, isValidRuleId } from "./rules";
import { LoadedConfig, createDefaultConfig } from "../config/loader";
import { parseSuppressionDirectives, isSuppressed } from "../config/suppression";
import { isCodeFile } from "./helpers";
import { analyzeFileContent } from "./detectors/file";
import { Finding } from "./detectors/types";

/**
 * Rules to check during baseline repository scan.
 */
export const BASELINE_SCAN_RULES = new Set<string>([
  // Critical architecture issues
  "STATEFUL_SERVICE",
  "PROTOTYPE_INFRA",
  "GLOBAL_MUTATION",
  // Security issues
  "HARDCODED_SECRET",
  "UNSAFE_EVAL",
  "HARDCODED_URL",
  // Scaling issues
  "UNBOUNDED_QUERY",
  "LOOPED_IO",
  "MEMORY_RISK",
  // Error handling issues
  "UNSAFE_IO",
  "SILENT_ERROR",
]);

/**
 * Result of baseline repository analysis.
 */
export interface BaselineAnalysisResult {
  /** All findings from the baseline scan */
  findings: Finding[];
  /** Number of files analyzed */
  filesAnalyzed: number;
  /** Number of files skipped (ignored by config or not code) */
  filesSkipped: number;
  /** Whether the scan was truncated due to maxFiles limit */
  truncated: boolean;
}

/**
 * Options for baseline repository analysis.
 */
export interface BaselineAnalysisOptions {
  /** The loaded configuration. If not provided, uses defaults. */
  config?: LoadedConfig;
  /** Maximum number of files to analyze (default: 200) */
  maxFiles?: number;
  /** Set of rule kinds to check. Defaults to BASELINE_SCAN_RULES. */
  rulesToCheck?: Set<string>;
}

/**
 * Analyze an entire repository to establish a baseline Vibe Score.
 *
 * Used when the GitHub App is first installed to give users an
 * immediate picture of their codebase's production readiness.
 *
 * @param fileContents - Map of file paths to their content
 * @param options - Analysis options
 * @returns BaselineAnalysisResult with findings and stats
 */
export function analyzeRepository(
  fileContents: Map<string, string>,
  options: BaselineAnalysisOptions = {}
): BaselineAnalysisResult {
  const config = options.config ?? createDefaultConfig();
  const maxFiles = options.maxFiles ?? 200;
  const rulesToCheck = options.rulesToCheck ?? BASELINE_SCAN_RULES;

  const allFindings: Finding[] = [];
  let filesAnalyzed = 0;
  let filesSkipped = 0;
  let truncated = false;

  for (const [filepath, content] of fileContents) {
    // Check file limit
    if (filesAnalyzed >= maxFiles) {
      truncated = true;
      break;
    }

    // Only analyze code files
    if (!isCodeFile(filepath)) {
      filesSkipped++;
      continue;
    }

    // Check if file is ignored by config
    if (config.isFileIgnored(filepath)) {
      filesSkipped++;
      continue;
    }

    filesAnalyzed++;

    // Parse suppression directives from the full file content
    const suppressions = parseSuppressionDirectives(content);

    // Check if file is in prototype zone
    const isInPrototypeZone = config.isPrototypeZone(filepath);

    // Run full-file analysis with specified rules
    const rawFindings = analyzeFileContent(filepath, content, { rulesToCheck });

    // Filter and enrich findings with config/suppression
    for (const finding of rawFindings) {
      if (isValidRuleId(finding.kind)) {
        const ruleConfig = config.getRuleConfig(finding.kind as RuleId, filepath);

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

  return {
    findings: allFindings,
    filesAnalyzed,
    filesSkipped,
    truncated,
  };
}
