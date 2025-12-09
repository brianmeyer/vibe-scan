/**
 * Vibe Score computation for production readiness assessment.
 *
 * This is a heuristic scoring system that combines static analysis findings
 * and LLM-identified issues into a single 0-100 score with a human-readable label.
 *
 * The weights can be tweaked based on real-world feedback and usage patterns.
 */

import { Finding } from "./analyzer";
import { LlmIssue } from "./llm";

export interface VibeScoreResult {
  score: number; // 0–100
  label: string; // "Excellent", "Good", etc.
}

/**
 * Compute a Vibe Score based on static findings and LLM issues.
 *
 * Scoring logic:
 * - Start at 100 (perfect score)
 * - Deduct points for each finding based on severity
 * - Clamp final score between 0 and 100
 *
 * Static finding penalties:
 * - high: -10 points
 * - medium: -5 points
 * - low: -2 points
 *
 * LLM issue penalties:
 * - severity 3 (high): -12 points
 * - severity 2 (medium): -7 points
 * - severity 1 (low): -3 points
 * - severity 0 (none): no penalty
 */
export function computeVibeScore(params: {
  staticFindings: Finding[];
  llmIssues: LlmIssue[];
}): VibeScoreResult {
  const { staticFindings, llmIssues } = params;

  let score = 100;

  // Static finding penalties
  for (const f of staticFindings) {
    switch (f.severity) {
      case "high":
        score -= 10;
        break;
      case "medium":
        score -= 5;
        break;
      case "low":
        score -= 2;
        break;
      default:
        break;
    }
  }

  // LLM issue penalties
  for (const issue of llmIssues) {
    switch (issue.severity) {
      case 3:
        score -= 12;
        break;
      case 2:
        score -= 7;
        break;
      case 1:
        score -= 3;
        break;
      case 0:
      default:
        break;
    }
  }

  // Clamp between 0 and 100
  if (score < 0) score = 0;
  if (score > 100) score = 100;

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

  return { score, label };
}
