/**
 * Vibe Score computation for production readiness assessment.
 *
 * This is a heuristic scoring system that combines static analysis findings
 * and LLM-identified issues into a single 0-100 score with a human-readable label.
 *
 * The weights can be tweaked based on real-world feedback and usage patterns.
 *
 * SCORING PHILOSOPHY:
 * - Scaling-related issues (unbounded queries, looped I/O, memory risks) hit HARDER
 *   because they're the #1 cause of vibe-coded production failures
 * - LLM issues are advisory and don't affect the numeric score
 * - Static findings drive the deterministic Vibe Score
 * - Rule levels (error/warning/info) affect the weight of each finding
 * - Config can provide a global weight_multiplier
 */

import { Finding } from "./analyzer";
import { LlmIssue } from "../integrations/llm";
import { RuleLevel } from "./rules";
import { RequiredScoringConfig, DEFAULT_SCORING_CONFIG } from "../config/schema";

export interface VibeScoreResult {
  score: number; // 0–100
  label: string; // "Excellent", "Good", etc.
  /** Whether the score is below the high-risk threshold. */
  isHighRisk: boolean;
}

/**
 * Set of scaling-related kind identifiers that receive heavier penalties.
 * These represent the most common causes of vibe-coded production failures.
 */
const SCALING_KINDS = new Set<string>([
  "UNBOUNDED_QUERY",
  "UNBOUNDED_COLLECTION_PROCESSING",
  "MISSING_BATCHING",
  "NO_CACHING",
  "MEMORY_RISK",
  "LOOPED_IO",
  "STATEFUL_SERVICE",
  "PROTOTYPE_INFRA",
]);

/**
 * Set of concurrency/contention-related kind identifiers that receive heavier penalties.
 * These represent race conditions and resource contention issues.
 */
const CONCURRENCY_KINDS = new Set<string>([
  "SHARED_FILE_WRITE",
  "RETRY_STORM_RISK",
  "BUSY_WAIT_OR_TIGHT_LOOP",
  "CHECK_THEN_ACT_RACE",
]);

/**
 * Set of security-related kind identifiers that receive heavier penalties.
 * These represent potential security vulnerabilities.
 */
const SECURITY_KINDS = new Set<string>([
  "HARDCODED_SECRET",
  "UNSAFE_EVAL",
]);

/**
 * Mapping from RuleLevel to a numeric weight multiplier.
 * - error: Full weight (1.0)
 * - warning: Half weight (0.5)
 * - info: Minimal weight (0.2)
 * - off: No weight (0, but should not have findings)
 */
export const LEVEL_WEIGHT: Record<RuleLevel, number> = {
  error: 1.0,
  warning: 0.5,
  info: 0.2,
  off: 0,
};

/**
 * Base penalties for findings by severity.
 */
const BASE_PENALTIES = {
  // Scaling/concurrency kinds (heavier penalties)
  scalingHigh: 15,
  scalingMedium: 8,
  scalingLow: 4,
  // Other kinds (baseline penalties)
  otherHigh: 10,
  otherMedium: 5,
  otherLow: 2,
};

/**
 * Options for Vibe Score computation.
 */
export interface VibeScoreOptions {
  /**
   * Scoring configuration from .vibecheck.yml.
   * If not provided, uses defaults.
   */
  scoringConfig?: RequiredScoringConfig;
}

/**
 * Compute a Vibe Score based on static findings and LLM issues.
 *
 * Scoring logic:
 * - Start at 100 (perfect score)
 * - Deduct points for each static finding based on severity
 * - Scaling-related kinds receive HEAVIER penalties
 * - Rule level (error/warning/info) applies a multiplier to the penalty
 * - Global weight_multiplier from config applies to all penalties
 * - Clamp final score between 0 and 100
 *
 * LLM issues are ADVISORY ONLY and do not affect the numeric score.
 * They are displayed to users but the Vibe Score remains deterministic
 * based solely on static analysis.
 */
export function computeVibeScore(params: {
  staticFindings: Finding[];
  llmIssues: LlmIssue[];
  options?: VibeScoreOptions;
}): VibeScoreResult {
  const { staticFindings, options } = params;
  // Note: llmIssues are intentionally not used in scoring - they're advisory only

  const scoringConfig = options?.scoringConfig ?? DEFAULT_SCORING_CONFIG;
  const globalMultiplier = scoringConfig.weight_multiplier;
  const highRiskThreshold = scoringConfig.high_risk_vibe_score;

  let score = 100;

  // Static finding penalties with scaling/concurrency/security-aware weighting
  for (const f of staticFindings) {
    const isScalingKind = SCALING_KINDS.has(f.kind);
    const isConcurrencyKind = CONCURRENCY_KINDS.has(f.kind);
    const isSecurityKind = SECURITY_KINDS.has(f.kind);

    // Get the level multiplier (default to "error" if no level set)
    const level: RuleLevel = f.level ?? "error";
    const levelMultiplier = LEVEL_WEIGHT[level];

    // Skip if level would result in 0 weight
    if (levelMultiplier === 0) {
      continue;
    }

    let basePenalty: number;

    if (isScalingKind || isConcurrencyKind || isSecurityKind) {
      // Heavier penalties for scaling, concurrency, and security-related issues
      switch (f.severity) {
        case "high":
          basePenalty = BASE_PENALTIES.scalingHigh;
          break;
        case "medium":
          basePenalty = BASE_PENALTIES.scalingMedium;
          break;
        case "low":
          basePenalty = BASE_PENALTIES.scalingLow;
          break;
        default:
          basePenalty = 0;
          break;
      }
    } else {
      // Baseline penalties for other issues
      switch (f.severity) {
        case "high":
          basePenalty = BASE_PENALTIES.otherHigh;
          break;
        case "medium":
          basePenalty = BASE_PENALTIES.otherMedium;
          break;
        case "low":
          basePenalty = BASE_PENALTIES.otherLow;
          break;
        default:
          basePenalty = 0;
          break;
      }
    }

    // Apply level multiplier and global multiplier
    const effectivePenalty = basePenalty * levelMultiplier * globalMultiplier;
    score -= effectivePenalty;
  }

  // Clamp between 0 and 100
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  // Round to nearest integer
  score = Math.round(score);

  // Determine label based on score
  let label: string;
  if (score >= 90) {
    label = "Excellent";
  } else if (score >= 75) {
    label = "Good";
  } else if (score >= 60) {
    label = "Moderate risk";
  } else if (score >= 40) {
    label = "Risky";
  } else {
    label = "Critical risk";
  }

  // Determine if high risk based on config threshold
  const isHighRisk = score < highRiskThreshold;

  return { score, label, isHighRisk };
}

/**
 * Legacy function signature for backwards compatibility.
 * @deprecated Use computeVibeScore with options parameter for config support.
 */
export function computeVibeScoreLegacy(params: {
  staticFindings: Finding[];
  llmIssues: LlmIssue[];
}): { score: number; label: string } {
  const result = computeVibeScore(params);
  return { score: result.score, label: result.label };
}
