/**
 * Executive summary preparation utilities.
 */

import { Finding } from "../../analysis/analyzer";
import { ExecutiveSummaryInput } from "../llm";

/**
 * Prepare input for executive summary generation.
 */
export function prepareExecutiveSummaryInput(
  findings: Finding[],
  vibeScore: number,
  installationId?: number
): ExecutiveSummaryInput {
  const findingsByKind = new Map<string, { count: number; severity: string; files: string[] }>();

  for (const f of findings) {
    const existing = findingsByKind.get(f.kind);
    if (existing) {
      existing.count++;
      if (!existing.files.includes(f.file)) {
        existing.files.push(f.file);
      }
      // Keep highest severity
      if (f.severity === "high") existing.severity = "high";
      else if (f.severity === "medium" && existing.severity !== "high") existing.severity = "medium";
    } else {
      findingsByKind.set(f.kind, {
        count: 1,
        severity: f.severity,
        files: [f.file],
      });
    }
  }

  // vibecheck-ignore-next-line UNBOUNDED_QUERY - Array.filter, not database query
  const highCount = findings.filter(f => f.severity === "high").length;
  // vibecheck-ignore-next-line UNBOUNDED_QUERY - Array.filter, not database query
  const mediumCount = findings.filter(f => f.severity === "medium").length;

  return {
    findingsByKind,
    totalFindings: findings.length,
    highCount,
    mediumCount,
    vibeScore,
    installationId,
  };
}
