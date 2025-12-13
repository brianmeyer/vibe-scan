/**
 * GitHub PR comment and check run output builders.
 */

import { Octokit } from "octokit";
import { Finding } from "../../analysis/analyzer";
import { LlmIssue, ValidatedFinding } from "../llm";
import {
  ArchitectureRiskSummary,
  GroupedFinding,
  GroupedValidatedFinding,
  RULE_DESCRIPTIONS,
} from "./types";

// ============================================================================
// High-Risk Comment Building
// ============================================================================

/**
 * Build the body of a high-risk PR comment.
 */
export function buildHighRiskCommentBody(params: {
  staticFindings: Finding[];
  llmIssues: LlmIssue[];
  vibeScore: number;
  vibeLabel: string;
  archSummary?: ArchitectureRiskSummary;
}): string | null {
  const { staticFindings, llmIssues, vibeScore, vibeLabel, archSummary } = params;

  const highStatic = staticFindings.filter((f) => f.severity === "high");
  const highLlm = llmIssues.filter((i) => i.severity === "high");

  // Show comment if there are high-risk findings OR if score is below 60
  const hasHighRisk = highStatic.length > 0 || highLlm.length > 0;
  const isRiskyScore = vibeScore < 60;

  if (!hasHighRisk && !isRiskyScore) {
    return null;
  }

  let body = `🚨 **Vibe Check Summary**\n\n`;
  body += `**Vibe Score: ${vibeScore} (${vibeLabel})**\n\n`;

  // Add compact architecture summary at the top
  if (archSummary) {
    const categories: { emoji: string; name: string; data: { count: number; topIssues: { file: string; line?: number; snippet: string }[] } }[] = [
      { emoji: "📈", name: "Scaling", data: archSummary.scaling },
      { emoji: "🔀", name: "Concurrency", data: archSummary.concurrency },
      { emoji: "⚠️", name: "Errors", data: archSummary.errorHandling },
      { emoji: "📋", name: "Data", data: archSummary.dataIntegrity },
      { emoji: "🔒", name: "Security", data: archSummary.security },
    ];

    const activeCategories = categories.filter((c) => c.data.count > 0);
    if (activeCategories.length > 0) {
      for (const cat of activeCategories) {
        body += `${cat.emoji} **${cat.name}** (${cat.data.count})`;
        if (cat.data.topIssues.length > 0) {
          const top = cat.data.topIssues[0];
          const loc = top.line ? `${top.file}:${top.line}` : top.file;
          body += ` – \`${loc}\` ${top.snippet}`;
          if (cat.data.count > 1) {
            body += ` _+${cat.data.count - 1} more_`;
          }
        }
        body += `\n`;
      }
      body += `\n`;
    }
  }

  // High-risk details (if any)
  if (highStatic.length) {
    body += `<details><summary>⚠️ ${highStatic.length} high-risk static finding(s)</summary>\n\n`;
    highStatic.slice(0, 5).forEach((f) => {
      const location = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      body += `- ${location} **${RULE_DESCRIPTIONS[f.kind] || f.kind}**\n`;
    });
    if (highStatic.length > 5) {
      body += `\n…and ${highStatic.length - 5} more.\n`;
    }
    body += `\n</details>\n\n`;
  }

  if (highLlm.length) {
    body += `<details><summary>🤖 ${highLlm.length} high-risk AI finding(s)</summary>\n\n`;
    highLlm.slice(0, 5).forEach((issue) => {
      body += `- **${issue.title}** – ${issue.summary}`;
      if (issue.suggestedFix) {
        body += ` 💡 ${issue.suggestedFix}`;
      }
      body += `\n`;
    });
    if (highLlm.length > 5) {
      body += `\n…and ${highLlm.length - 5} more.\n`;
    }
    body += `\n</details>\n`;
  }

  body += `\n_See check run for full details._`;

  return body;
}

/**
 * Post a high-risk summary comment on a PR.
 */
export async function postHighRiskComment(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  body: string;
}): Promise<void> {
  const { octokit, owner, repo, pullNumber, body } = params;

  try {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
    console.log("[GitHub App] Posted high-risk summary comment on PR", `${owner}/${repo}#${pullNumber}`);
  } catch (err) {
    console.error("[GitHub App] Failed to post high-risk summary comment:", err instanceof Error ? err.message : "unknown error");
  }
}

// ============================================================================
// Grouped Findings Display
// ============================================================================

/**
 * Group static findings by rule kind for better display.
 */
export function groupStaticFindingsByKind(findings: Finding[]): GroupedFinding[] {
  const groups = new Map<string, GroupedFinding>();

  for (const f of findings) {
    const existing = groups.get(f.kind);
    if (existing) {
      existing.count++;
      existing.locations.push({ file: f.file, line: f.line });
      // Upgrade severity if higher
      if (f.severity === "high" && existing.severity !== "high") {
        existing.severity = "high";
      } else if (f.severity === "medium" && existing.severity === "low") {
        existing.severity = "medium";
      }
    } else {
      groups.set(f.kind, {
        kind: f.kind,
        count: 1,
        severity: f.severity,
        description: RULE_DESCRIPTIONS[f.kind] || f.message || f.kind,
        locations: [{ file: f.file, line: f.line }],
      });
    }
  }

  // Sort by severity (high first) then by count (descending)
  return Array.from(groups.values()).sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return b.count - a.count;
  });
}

/**
 * Build grouped findings display text.
 */
export function buildGroupedFindingsDisplay(
  groupedFindings: GroupedFinding[],
  maxGroupsToShow: number = 8,
  maxLocationsPerGroup: number = 3
): string {
  if (groupedFindings.length === 0) {
    return "_No static issues detected in this diff._\n";
  }

  let text = "";
  let groupsShown = 0;
  let totalFindingsShown = 0;
  const totalFindings = groupedFindings.reduce((sum, g) => sum + g.count, 0);

  for (const group of groupedFindings) {
    if (groupsShown >= maxGroupsToShow) break;

    const severityBadge = group.severity.toUpperCase();
    const countLabel = group.count > 1 ? `(${group.count} findings)` : "(1 finding)";

    text += `### [${severityBadge}] ${group.kind} ${countLabel}\n`;
    text += `${group.description}\n`;

    // Show locations
    const locationsToShow = group.locations.slice(0, maxLocationsPerGroup);
    const locationStrings = locationsToShow.map(loc =>
      loc.line ? `${loc.file}:${loc.line}` : loc.file
    );

    text += `📍 ${locationStrings.join(", ")}`;
    if (group.locations.length > maxLocationsPerGroup) {
      text += ` (+${group.locations.length - maxLocationsPerGroup} more)`;
    }
    text += "\n\n";

    groupsShown++;
    totalFindingsShown += group.count;
  }

  if (groupedFindings.length > maxGroupsToShow) {
    const remainingGroups = groupedFindings.length - maxGroupsToShow;
    const remainingFindings = totalFindings - totalFindingsShown;
    text += `_+ ${remainingGroups} more issue type(s) with ${remainingFindings} finding(s) not shown._\n`;
  }

  return text;
}

// ============================================================================
// Validated Findings Display with Confidence Scores
// ============================================================================

/**
 * Get confidence badge emoji based on score.
 */
export function getConfidenceBadge(confidence: number): string {
  if (confidence >= 0.9) return "🔴"; // Very high confidence
  if (confidence >= 0.7) return "🟠"; // High confidence
  if (confidence >= 0.5) return "🟡"; // Medium confidence
  return "⚪"; // Low confidence (likely false positive)
}

/**
 * Get confidence label text.
 */
export function getConfidenceLabel(confidence: number): string {
  if (confidence >= 0.9) return "very high";
  if (confidence >= 0.7) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

/**
 * Group validated findings by rule kind for display.
 */
export function groupValidatedFindingsByKind(
  validatedFindings: ValidatedFinding[],
  confidenceThreshold: number
): GroupedValidatedFinding[] {
  const groups = new Map<string, GroupedValidatedFinding>();

  for (const f of validatedFindings) {
    const existing = groups.get(f.ruleId);
    if (existing) {
      if (!f.likelyFalsePositive) {
        existing.count++;
        existing.locations.push({ file: f.file, line: f.line, confidence: f.confidence });
        // Update average confidence
        const totalConfidence = existing.avgConfidence * (existing.locations.length - 1) + f.confidence;
        existing.avgConfidence = totalConfidence / existing.locations.length;
        // Upgrade severity if higher
        if (f.severity === "high" && existing.severity !== "high") {
          existing.severity = "high";
        } else if (f.severity === "medium" && existing.severity === "low") {
          existing.severity = "medium";
        }
      } else {
        existing.filteredCount++;
      }
    } else {
      if (!f.likelyFalsePositive) {
        groups.set(f.ruleId, {
          kind: f.ruleId,
          count: 1,
          severity: f.severity,
          description: RULE_DESCRIPTIONS[f.ruleId] || f.summary || f.ruleId,
          avgConfidence: f.confidence,
          locations: [{ file: f.file, line: f.line, confidence: f.confidence }],
          filteredCount: 0,
        });
      } else {
        groups.set(f.ruleId, {
          kind: f.ruleId,
          count: 0,
          severity: f.severity,
          description: RULE_DESCRIPTIONS[f.ruleId] || f.summary || f.ruleId,
          avgConfidence: 0,
          locations: [],
          filteredCount: 1,
        });
      }
    }
  }

  // Filter out groups with no remaining findings after confidence filtering
  const activeGroups = Array.from(groups.values()).filter(g => g.count > 0);

  // Sort by severity (high first), then by average confidence (descending)
  return activeGroups.sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return b.avgConfidence - a.avgConfidence;
  });
}

/**
 * Build display for validated findings with confidence scores.
 */
export function buildValidatedFindingsDisplay(
  groupedFindings: GroupedValidatedFinding[],
  filteredCount: number,
  maxGroupsToShow: number = 8,
  maxLocationsPerGroup: number = 3
): string {
  if (groupedFindings.length === 0 && filteredCount === 0) {
    return "_No static issues detected in this diff._\n";
  }

  if (groupedFindings.length === 0 && filteredCount > 0) {
    return `_All ${filteredCount} static finding(s) were determined to be likely false positives by LLM validation._\n`;
  }

  let text = "";
  let groupsShown = 0;
  let totalFindingsShown = 0;
  const totalFindings = groupedFindings.reduce((sum, g) => sum + g.count, 0);

  for (const group of groupedFindings) {
    if (groupsShown >= maxGroupsToShow) break;

    const severityBadge = group.severity.toUpperCase();
    const confidenceBadge = getConfidenceBadge(group.avgConfidence);
    const confidenceLabel = getConfidenceLabel(group.avgConfidence);
    const countLabel = group.count > 1 ? `(${group.count} findings)` : "(1 finding)";

    text += `### ${confidenceBadge} [${severityBadge}] ${group.kind} ${countLabel}\n`;
    text += `${group.description} • _${confidenceLabel} confidence_\n`;

    // Show locations with individual confidence
    const locationsToShow = group.locations
      .sort((a, b) => b.confidence - a.confidence) // Highest confidence first
      .slice(0, maxLocationsPerGroup);

    const locationStrings = locationsToShow.map(loc => {
      const badge = getConfidenceBadge(loc.confidence);
      const locStr = loc.line ? `${loc.file}:${loc.line}` : loc.file;
      return `${badge} ${locStr}`;
    });

    text += `📍 ${locationStrings.join(", ")}`;
    if (group.locations.length > maxLocationsPerGroup) {
      text += ` (+${group.locations.length - maxLocationsPerGroup} more)`;
    }
    text += "\n\n";

    groupsShown++;
    totalFindingsShown += group.count;
  }

  if (groupedFindings.length > maxGroupsToShow) {
    const remainingGroups = groupedFindings.length - maxGroupsToShow;
    const remainingFindings = totalFindings - totalFindingsShown;
    text += `_+ ${remainingGroups} more issue type(s) with ${remainingFindings} finding(s) not shown._\n`;
  }

  if (filteredCount > 0) {
    text += `\n_${filteredCount} finding(s) filtered as likely false positives._\n`;
  }

  // Legend
  text += `\n**Confidence Legend:** 🔴 very high • 🟠 high • 🟡 medium\n`;

  return text;
}
