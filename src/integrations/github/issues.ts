/**
 * GitHub issue creation for findings.
 */

import { Octokit } from "octokit";
import { Finding } from "../../analysis/analyzer";
import { groupStaticFindingsByKind } from "./comments";

/**
 * Create GitHub issues for high-severity findings.
 */
export async function createIssuesForFindings(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  findings: Finding[];
  config: {
    create_issues: boolean;
    max_issues_per_pr: number;
    issue_severity_threshold: "high" | "medium" | "low";
    issue_labels: string[];
  };
}): Promise<number> {
  const { octokit, owner, repo, prNumber, prTitle, findings, config } = params;

  if (!config.create_issues) {
    return 0;
  }

  // Filter findings by severity threshold
  const severityOrder = { high: 3, medium: 2, low: 1 };
  const thresholdValue = severityOrder[config.issue_severity_threshold];
  // vibescale-ignore-next-line UNBOUNDED_QUERY - Array.filter, not database query
  const eligibleFindings = findings.filter(
    (f) => severityOrder[f.severity] >= thresholdValue
  );

  if (eligibleFindings.length === 0) {
    console.log("[GitHub Issues] No findings meet severity threshold");
    return 0;
  }

  // Group findings by kind to avoid creating duplicate issues
  const groupedFindings = groupStaticFindingsByKind(eligibleFindings);

  // Create issues for top groups (up to max)
  let issuesCreated = 0;
  for (const group of groupedFindings.slice(0, config.max_issues_per_pr)) {
    try {
      const locations = group.locations
        .slice(0, 5)
        .map((loc) => (loc.line ? `- \`${loc.file}:${loc.line}\`` : `- \`${loc.file}\``))
        .join("\n");

      const moreLocations =
        group.locations.length > 5 ? `\n- _+${group.locations.length - 5} more locations_` : "";

      const body = `## Vibe Scale: ${group.kind}

**Severity:** ${group.severity.toUpperCase()}
**PR:** #${prNumber} - ${prTitle}
**Findings:** ${group.count}

### Description
${group.description}

### Locations
${locations}${moreLocations}

### Recommended Action
Review and address these findings before merging to production.

---
_This issue was automatically created by [Vibe Scale](https://github.com/apps/vibe-scale)._`;

      await octokit.request("POST /repos/{owner}/{repo}/issues", {
        owner,
        repo,
        title: `[Vibe Scale] ${group.kind}: ${group.count} finding(s) in PR #${prNumber}`,
        body,
        labels: config.issue_labels,
      });

      issuesCreated++;
      console.log(`[GitHub Issues] Created issue for ${group.kind}`);
    } catch (err) {
      // vibescale-ignore-next-line SILENT_ERROR - Intentional: continue creating other issues
      console.error(
        `[GitHub Issues] Failed to create issue for ${group.kind}:`,
        err instanceof Error ? err.message : "unknown"
      );
    }
  }

  return issuesCreated;
}
