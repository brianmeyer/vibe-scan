/**
 * Architecture risk summary computation and display.
 */

import { Finding } from "../../analysis/analyzer";
import { LlmIssue } from "../llm";
import {
  ArchIssue,
  ArchitectureRiskSummary,
  SCALING_KINDS,
  CONCURRENCY_KINDS,
  ERROR_HANDLING_KINDS,
  DATA_INTEGRITY_KINDS,
  SECURITY_KINDS,
  MAX_TOP_ISSUES_PER_CATEGORY,
  RULE_DESCRIPTIONS,
} from "./types";

/**
 * Compute an architecture risk summary from static findings and LLM issues.
 * Groups findings into risk categories and captures top issues for display.
 */
export function computeArchitectureRiskSummary(params: {
  staticFindings: Finding[];
  llmIssues: LlmIssue[];
}): ArchitectureRiskSummary {
  const { staticFindings, llmIssues } = params;

  // Collect issues by category
  const scalingIssues: ArchIssue[] = [];
  const concurrencyIssues: ArchIssue[] = [];
  const errorHandlingIssues: ArchIssue[] = [];
  const dataIntegrityIssues: ArchIssue[] = [];
  const securityIssues: ArchIssue[] = [];

  // Helper to convert finding to ArchIssue
  const toArchIssue = (f: Finding): ArchIssue => ({
    file: f.file,
    line: f.line,
    snippet: RULE_DESCRIPTIONS[f.kind] || f.kind,
    kind: f.kind,
  });

  // Helper to convert LLM issue to ArchIssue
  const llmToArchIssue = (issue: LlmIssue): ArchIssue => ({
    file: issue.file || "unknown",
    line: issue.line,
    snippet: issue.title || RULE_DESCRIPTIONS[issue.kind] || issue.kind,
    kind: issue.kind,
  });

  // Categorize static findings (prioritize high severity)
  const sortedFindings = [...staticFindings].sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    return (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2);
  });

  for (const f of sortedFindings) {
    if (SCALING_KINDS.has(f.kind)) {
      scalingIssues.push(toArchIssue(f));
    } else if (CONCURRENCY_KINDS.has(f.kind)) {
      concurrencyIssues.push(toArchIssue(f));
    } else if (ERROR_HANDLING_KINDS.has(f.kind)) {
      errorHandlingIssues.push(toArchIssue(f));
    } else if (DATA_INTEGRITY_KINDS.has(f.kind)) {
      dataIntegrityIssues.push(toArchIssue(f));
    } else if (SECURITY_KINDS.has(f.kind)) {
      securityIssues.push(toArchIssue(f));
    }
  }

  // Categorize LLM issues
  for (const issue of llmIssues) {
    const archIssue = llmToArchIssue(issue);
    switch (issue.kind) {
      case "SCALING_RISK":
      case "ENVIRONMENT_ASSUMPTION":
        scalingIssues.push(archIssue);
        break;
      case "CONCURRENCY_RISK":
        concurrencyIssues.push(archIssue);
        break;
      case "RESILIENCE_GAP":
      case "OBSERVABILITY_GAP":
        errorHandlingIssues.push(archIssue);
        break;
      case "DATA_CONTRACT_RISK":
        dataIntegrityIssues.push(archIssue);
        break;
    }
  }

  return {
    scaling: {
      count: scalingIssues.length,
      topIssues: scalingIssues.slice(0, MAX_TOP_ISSUES_PER_CATEGORY),
    },
    concurrency: {
      count: concurrencyIssues.length,
      topIssues: concurrencyIssues.slice(0, MAX_TOP_ISSUES_PER_CATEGORY),
    },
    errorHandling: {
      count: errorHandlingIssues.length,
      topIssues: errorHandlingIssues.slice(0, MAX_TOP_ISSUES_PER_CATEGORY),
    },
    dataIntegrity: {
      count: dataIntegrityIssues.length,
      topIssues: dataIntegrityIssues.slice(0, MAX_TOP_ISSUES_PER_CATEGORY),
    },
    security: {
      count: securityIssues.length,
      topIssues: securityIssues.slice(0, MAX_TOP_ISSUES_PER_CATEGORY),
    },
  };
}

/**
 * Build a markdown section for the architecture risk summary.
 * Shows top issues with locations, not just counts.
 */
export function buildArchitectureRiskSection(summary: ArchitectureRiskSummary): string {
  let text = "## Architecture Risk Summary\n\n";

  const hasAnyRisks =
    summary.scaling.count > 0 ||
    summary.concurrency.count > 0 ||
    summary.errorHandling.count > 0 ||
    summary.dataIntegrity.count > 0 ||
    summary.security.count > 0;

  if (!hasAnyRisks) {
    text += "_No major architectural risk patterns detected._\n";
    return text;
  }

  // Helper to format a category
  const formatCategory = (
    emoji: string,
    name: string,
    data: { count: number; topIssues: ArchIssue[] }
  ): string => {
    if (data.count === 0) return "";

    let section = `**${emoji} ${name}** (${data.count})\n`;
    for (const issue of data.topIssues) {
      const loc = issue.line ? `${issue.file}:${issue.line}` : issue.file;
      section += `- \`${loc}\` ${issue.snippet}\n`;
    }
    if (data.count > data.topIssues.length) {
      section += `- _+${data.count - data.topIssues.length} more_\n`;
    }
    return section + "\n";
  };

  text += formatCategory("📈", "Scaling", summary.scaling);
  text += formatCategory("🔀", "Concurrency", summary.concurrency);
  text += formatCategory("⚠️", "Error Handling", summary.errorHandling);
  text += formatCategory("📋", "Data Integrity", summary.dataIntegrity);
  text += formatCategory("🔒", "Security", summary.security);

  return text;
}
