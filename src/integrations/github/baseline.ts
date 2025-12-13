/**
 * Baseline repository scanning on app installation.
 */

import { Octokit } from "octokit";
import { Finding, analyzeRepository, BaselineAnalysisResult } from "../../analysis/analyzer";
import { computeVibeScore } from "../../analysis/scoring";
import {
  StaticFindingSummary,
  validateFindingsWithLlm,
  ValidatedFinding,
} from "../llm";
import { createInstallationOctokit } from "./client";
import { fetchRepoConfig } from "./config";
import { fetchFileContent } from "./files";
import {
  getConfidenceBadge,
  getConfidenceLabel,
} from "./comments";
import {
  BaselineScanParams,
  BaselineIssueParams,
  BASELINE_MAX_FILE_SIZE,
  BASELINE_MAX_FILES,
  BASELINE_MAX_TOTAL_BYTES,
} from "./types";

/**
 * Perform baseline scan on a repository when the app is installed.
 * Creates an issue with the Vibe Score and findings.
 */
export async function performBaselineScan(params: BaselineScanParams): Promise<void> {
  const { installationId, owner, repoName, repoFullName } = params;

  console.log(`[Baseline] Starting baseline scan for ${repoFullName}...`);

  const octokit = createInstallationOctokit(installationId);

  try {
    // Get default branch
    const repoInfo = await octokit.request("GET /repos/{owner}/{repo}", {
      owner,
      repo: repoName,
    });
    const defaultBranch = repoInfo.data.default_branch;
    console.log(`[Baseline] Default branch: ${defaultBranch}`);

    // Fetch config
    const vibescaleConfig = await fetchRepoConfig(octokit, owner, repoName, defaultBranch, defaultBranch);

    // Get file tree
    const treeResponse = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo: repoName,
      tree_sha: defaultBranch,
      recursive: "true",
    });

    // Filter to code files
    const codeFileExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rb", ".java", ".cs"]);
    const codeFiles = treeResponse.data.tree.filter((item: { type?: string; path?: string; size?: number }) => {
      if (item.type !== "blob") return false;
      if (!item.path) return false;
      const ext = item.path.substring(item.path.lastIndexOf("."));
      if (!codeFileExtensions.has(ext)) return false;
      // Skip test files
      if (item.path.includes("/test/") || item.path.includes("/tests/") || item.path.includes("__tests__")) return false;
      if (item.path.includes(".test.") || item.path.includes(".spec.") || item.path.includes("_test.")) return false;
      // Skip vendor/node_modules
      if (item.path.includes("node_modules/") || item.path.includes("vendor/") || item.path.includes("dist/")) return false;
      if (item.size && item.size > BASELINE_MAX_FILE_SIZE) return false;
      return true;
    });

    console.log(`[Baseline] Found ${codeFiles.length} code files (excluding tests)`);

    // Limit files
    const filesToAnalyze = codeFiles.slice(0, BASELINE_MAX_FILES);

    // Fetch file contents with batching (intentional loop pattern for rate limiting)
    // vibescale-ignore-next-line LOOPED_IO
    const fileContents = new Map<string, string>();
    const batchSize = 10;
    let totalBytes = 0;
    let memoryLimitReached = false;

    for (let i = 0; i < filesToAnalyze.length && !memoryLimitReached; i += batchSize) {
      const batch = filesToAnalyze.slice(i, i + batchSize);
      const promises = batch.map(async (file: { path?: string }) => {
        if (!file.path || memoryLimitReached) return;
        try {
          const content = await fetchFileContent(octokit, owner, repoName, file.path, defaultBranch);
          if (content) {
            // Check memory limit before adding
            if (totalBytes + content.length > BASELINE_MAX_TOTAL_BYTES) {
              memoryLimitReached = true;
              console.warn(`[Baseline] Memory limit reached (${BASELINE_MAX_TOTAL_BYTES} bytes), stopping file fetch`);
              return;
            }
            totalBytes += content.length;
            fileContents.set(file.path, content);
          }
        } catch (err) {
          // Individual file failures shouldn't stop the scan
          console.warn(`[Baseline] Failed to fetch ${file.path}:`, err instanceof Error ? err.message : "unknown error");
        }
      });
      await Promise.all(promises);
    }

    console.log(`[Baseline] Fetched ${fileContents.size}/${filesToAnalyze.length} file(s), ${(totalBytes / 1024).toFixed(1)}KB total`);

    // Run analysis
    const baselineResult: BaselineAnalysisResult = analyzeRepository(fileContents, {
      config: vibescaleConfig,
    });

    console.log(`[Baseline] Analysis complete: ${baselineResult.findings.length} findings in ${baselineResult.filesAnalyzed} files`);

    // Convert findings to StaticFindingSummary for LLM validation
    const staticFindingSummaries: StaticFindingSummary[] = baselineResult.findings.map((f) => ({
      ruleId: f.kind,
      kind: f.kind,
      file: f.file,
      line: f.line ?? 0,
      severity: f.severity === "high" ? "high" : f.severity === "medium" ? "medium" : "low",
      summary: f.message,
    }));

    // Validate findings with LLM for confidence scoring (if enabled)
    let validatedFindings: ValidatedFinding[] | null = null;
    let validationFilteredCount = 0;
    if (baselineResult.findings.length > 0 && vibescaleConfig.llm.validate_findings) {
      try {
        console.log("[Baseline] Validating findings with LLM...");
        const validationResult = await validateFindingsWithLlm({
          findings: staticFindingSummaries,
          codeContext: fileContents,
          installationId,
          confidenceThreshold: vibescaleConfig.llm.confidence_threshold,
        });
        if (validationResult) {
          validatedFindings = validationResult.validatedFindings;
          validationFilteredCount = validationResult.filteredCount;
          console.log(
            `[Baseline] Validation complete: ${validatedFindings.length} findings, ` +
            `${validationFilteredCount} filtered as likely false positives, ` +
            `${validationResult.tokensUsed} tokens used`
          );
        }
      } catch (err) {
        console.warn("[Baseline] Finding validation failed:", err instanceof Error ? err.message : "unknown");
      }
    }

    // Compute Vibe Score (use validated findings if available to filter false positives from score)
    const findingsForScore = validatedFindings
      ? baselineResult.findings.filter((f) => {
          const validated = validatedFindings!.find(
            (v) => v.file === f.file && v.line === (f.line ?? 0) && v.ruleId === f.kind
          );
          return !validated?.likelyFalsePositive;
        })
      : baselineResult.findings;

    const vibeScoreResult = computeVibeScore({
      staticFindings: findingsForScore,
      llmIssues: [],
      options: { scoringConfig: vibescaleConfig.scoring },
    });

    // Create issue
    const issueBody = buildBaselineIssueBody({
      vibeScore: vibeScoreResult.score,
      vibeLabel: vibeScoreResult.label,
      findings: baselineResult.findings,
      validatedFindings,
      filteredCount: validationFilteredCount,
      filesAnalyzed: baselineResult.filesAnalyzed,
      filesSkipped: baselineResult.filesSkipped,
      truncated: baselineResult.truncated,
      totalCodeFiles: codeFiles.length,
    });

    await octokit.request("POST /repos/{owner}/{repo}/issues", {
      owner,
      repo: repoName,
      title: `Vibe Scale Baseline: Score ${vibeScoreResult.score}/100 (${vibeScoreResult.label})`,
      body: issueBody,
      labels: ["vibe-scale", "baseline"],
    });

    console.log(`[Baseline] Created baseline issue for ${repoFullName}`);
  } catch (error) {
    console.error(`[Baseline] Error scanning ${repoFullName}:`, error instanceof Error ? error.message : "unknown error");
    throw error; // Re-throw so caller knows it failed
  }
}

/**
 * Build markdown body for baseline scan issue.
 */
export function buildBaselineIssueBody(params: BaselineIssueParams): string {
  const { vibeScore, vibeLabel, findings, validatedFindings, filteredCount = 0, filesAnalyzed, filesSkipped, truncated, totalCodeFiles } = params;

  let body = `# Vibe Scale Baseline Report\n\n`;
  body += `Welcome to Vibe Scale! This is your baseline production readiness assessment.\n\n`;

  // Score
  body += `## Vibe Score: **${vibeScore}/100** (${vibeLabel})\n\n`;

  if (vibeScore >= 90) {
    body += `Excellent! Your codebase looks production-ready.\n\n`;
  } else if (vibeScore >= 75) {
    body += `Good! Minor improvements recommended before scaling.\n\n`;
  } else if (vibeScore >= 60) {
    body += `Moderate Risk - Several issues should be addressed before production.\n\n`;
  } else if (vibeScore >= 40) {
    body += `Risky - Significant concerns that could cause production failures.\n\n`;
  } else {
    body += `Critical Risk - Major architectural issues detected. Not recommended for production.\n\n`;
  }

  // Stats
  body += `### Analysis Stats\n`;
  body += `- **Files Analyzed:** ${filesAnalyzed} of ${totalCodeFiles}\n`;
  if (filesSkipped > 0) {
    body += `- **Files Skipped:** ${filesSkipped}\n`;
  }
  if (truncated) {
    body += `- *Analysis was truncated at ${filesAnalyzed} files*\n`;
  }
  body += `- **Issues Found:** ${findings.length}`;
  if (filteredCount > 0) {
    body += ` (${filteredCount} filtered as likely false positives)`;
  }
  body += `\n\n`;

  // Findings summary - use validated findings if available
  if (validatedFindings && validatedFindings.length > 0) {
    // Filter to only show true positives (not filtered)
    const truePositives = validatedFindings.filter((f) => !f.likelyFalsePositive);
    const high = truePositives.filter((f) => f.severity === "high");
    const medium = truePositives.filter((f) => f.severity === "medium");
    const low = truePositives.filter((f) => f.severity === "low");

    body += `## Findings Summary\n\n`;
    body += `| Severity | Count |\n|----------|-------|\n`;
    body += `| High | ${high.length} |\n`;
    body += `| Medium | ${medium.length} |\n`;
    body += `| Low | ${low.length} |\n\n`;

    if (filteredCount > 0) {
      body += `_${filteredCount} finding(s) were filtered as likely false positives by LLM validation._\n\n`;
    }

    // High severity details with confidence
    if (high.length > 0) {
      body += `### High Severity Issues\n\n`;

      const byKind = new Map<string, ValidatedFinding[]>();
      for (const f of high) {
        if (!byKind.has(f.ruleId)) byKind.set(f.ruleId, []);
        byKind.get(f.ruleId)!.push(f);
      }

      for (const [kind, kindFindings] of byKind) {
        const avgConfidence = kindFindings.reduce((sum, f) => sum + f.confidence, 0) / kindFindings.length;
        const badge = getConfidenceBadge(avgConfidence);
        body += `${badge} **${kind}** (${kindFindings.length}) - _${getConfidenceLabel(avgConfidence)} confidence_\n`;
        const examples = kindFindings.slice(0, 3);
        for (const f of examples) {
          body += `- \`${f.file}${f.line ? `:${f.line}` : ""}\`\n`;
        }
        if (kindFindings.length > 3) {
          body += `- _...and ${kindFindings.length - 3} more_\n`;
        }
        body += `\n`;
      }
    }

    // Medium severity details with confidence
    if (medium.length > 0) {
      body += `### Medium Severity Issues\n\n`;

      const byKind = new Map<string, ValidatedFinding[]>();
      for (const f of medium) {
        if (!byKind.has(f.ruleId)) byKind.set(f.ruleId, []);
        byKind.get(f.ruleId)!.push(f);
      }

      for (const [kind, kindFindings] of byKind) {
        const avgConfidence = kindFindings.reduce((sum, f) => sum + f.confidence, 0) / kindFindings.length;
        const badge = getConfidenceBadge(avgConfidence);
        body += `${badge} **${kind}** (${kindFindings.length}) - _${getConfidenceLabel(avgConfidence)} confidence_\n`;
        const examples = kindFindings.slice(0, 3);
        for (const f of examples) {
          body += `- \`${f.file}${f.line ? `:${f.line}` : ""}\`\n`;
        }
        if (kindFindings.length > 3) {
          body += `- _...and ${kindFindings.length - 3} more_\n`;
        }
        body += `\n`;
      }
    }

    body += `**Confidence Legend:** 🔴 very high • 🟠 high • 🟡 medium\n\n`;
  } else if (findings.length > 0) {
    // Fallback to original display without validation
    const high = findings.filter((f) => f.severity === "high");
    const medium = findings.filter((f) => f.severity === "medium");
    const low = findings.filter((f) => f.severity === "low");

    body += `## Findings Summary\n\n`;
    body += `| Severity | Count |\n|----------|-------|\n`;
    body += `| High | ${high.length} |\n`;
    body += `| Medium | ${medium.length} |\n`;
    body += `| Low | ${low.length} |\n\n`;

    // High severity details
    if (high.length > 0) {
      body += `### High Severity Issues\n\n`;

      const byKind = new Map<string, Finding[]>();
      for (const f of high) {
        if (!byKind.has(f.kind)) byKind.set(f.kind, []);
        byKind.get(f.kind)!.push(f);
      }

      for (const [kind, kindFindings] of byKind) {
        body += `**${kind}** (${kindFindings.length})\n`;
        const examples = kindFindings.slice(0, 3);
        for (const f of examples) {
          body += `- \`${f.file}${f.line ? `:${f.line}` : ""}\`\n`;
        }
        if (kindFindings.length > 3) {
          body += `- _...and ${kindFindings.length - 3} more_\n`;
        }
        body += `\n`;
      }
    }
  } else {
    body += `## No Issues Found\n\nNo critical production risks were detected.\n\n`;
  }

  // Next steps
  body += `## Next Steps\n\n`;
  body += `1. Review the findings above and prioritize high-severity issues\n`;
  body += `2. Configure Vibe Scale by adding a \`.vibescale.yml\` file\n`;
  body += `3. PRs will be analyzed automatically\n\n`;

  body += `---\n_Baseline scan from Vibe Scale installation._\n`;

  return body;
}
