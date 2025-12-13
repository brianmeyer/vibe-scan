/**
 * GitHub webhook event handlers.
 */

import { Webhooks } from "@octokit/webhooks";
import { config } from "../../env";
import {
  analyzePullRequestPatchesWithConfig,
  Finding,
} from "../../analysis/analyzer";
import {
  analyzeSnippetWithLlm,
  LlmIssue,
  LLM_ISSUE_KIND_LABELS,
  groupIssuesByKind,
  StaticFindingSummary,
  generateExecutiveSummary,
  validateFindingsWithLlm,
  ValidatedFinding,
} from "../llm";
import { computeVibeScore, VibeScoreResult } from "../../analysis/scoring";
import { extractFileStructure } from "../../analysis/structure";
import { canAnalyzeWithAST } from "../../analysis/ast";
import { handleMarketplacePurchase, MarketplacePurchasePayload, getInstallationLimits } from "../../plans";
import { createInstallationOctokit } from "./client";
import { fetchRepoConfig } from "./config";
import { fetchFileContent, isCodeFile, selectLlmCandidates, redactSecrets } from "./files";
import { computeArchitectureRiskSummary, buildArchitectureRiskSection } from "./architecture";
import {
  buildHighRiskCommentBody,
  postHighRiskComment,
  groupStaticFindingsByKind,
  buildGroupedFindingsDisplay,
  groupValidatedFindingsByKind,
  buildValidatedFindingsDisplay,
} from "./comments";
import { createIssuesForFindings } from "./issues";
import { prepareExecutiveSummaryInput } from "./summary";
import { performBaselineScan } from "./baseline";
import { PrFilePatch } from "./types";

export const webhooks = new Webhooks({
  secret: config.GITHUB_WEBHOOK_SECRET || "development-secret",
});

export function registerEventHandlers(): void {
  webhooks.on("pull_request", async ({ id, name, payload }) => {
    console.log(`[GitHub App] Received ${name} event (id: ${id}):`, payload.action);

    const installationId = (payload as { installation?: { id: number } }).installation?.id;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const headSha = payload.pull_request.head.sha;
    const headRef = payload.pull_request.head.ref;
    const baseRef = payload.pull_request.base.ref;
    const pullNumber = payload.number;
    const action = payload.action;

    // Only proceed for relevant actions
    if (!["opened", "reopened", "synchronize"].includes(action)) {
      return;
    }

    if (!installationId) {
      console.warn("[GitHub App] No installation ID found in payload, skipping check run creation");
      return;
    }

    try {
      const octokit = createInstallationOctokit(installationId);

      // Fetch repository configuration (.vibescale.yml)
      console.log(`[GitHub App] Fetching config for ${owner}/${repo}...`);
      const vibescanConfig = await fetchRepoConfig(octokit, owner, repo, headRef, baseRef);

      // Fetch PR files with patches
      console.log(`[GitHub App] Fetching files for PR #${pullNumber}...`);
      const filesResponse = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 50,
      });

      const prFiles: PrFilePatch[] = filesResponse.data.map((f: { filename: string; patch?: string }) => ({
        filename: f.filename,
        patch: f.patch,
      }));

      // Early exit: skip analysis if no code files changed (e.g., README-only PRs)
      const codeFiles = prFiles.filter((f) => isCodeFile(f.filename));
      if (codeFiles.length === 0) {
        console.log(`[GitHub App] No code files in PR, skipping analysis (${prFiles.length} non-code file(s))`);
        await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
          owner,
          repo,
          name: "Vibe Scale",
          head_sha: headSha,
          status: "completed",
          conclusion: "neutral",
          output: {
            title: "No code changes to analyze",
            summary: "This PR only contains non-code files (docs, config, etc.). Vibe Scale skipped.",
          },
        });
        return;
      }

      // Fetch file contents for AST analysis (parallel fetch for efficiency)
      console.log(`[GitHub App] Fetching file contents for AST analysis...`);
      const fileContents = new Map<string, string>();
      const astCandidates = prFiles.filter(
        (f) => f.patch && canAnalyzeWithAST(f.filename) && !vibescanConfig.isFileIgnored(f.filename)
      );

      if (astCandidates.length > 0) {
        const fetchPromises = astCandidates.map(async (f) => {
          const content = await fetchFileContent(octokit, owner, repo, f.filename, headSha);
          if (content) {
            fileContents.set(f.filename, content);
          }
        });
        await Promise.all(fetchPromises);
        console.log(
          `[GitHub App] Fetched ${fileContents.size}/${astCandidates.length} file(s) for AST analysis`
        );
      }

      console.log(`[GitHub App] Analyzing ${prFiles.length} file(s) (${fileContents.size} with AST)...`);
      const staticFindings = analyzePullRequestPatchesWithConfig(prFiles, {
        config: vibescanConfig,
        fileContents,
      });

      // Compute static stats
      const totalFindings = staticFindings.length;
      const highCount = staticFindings.filter((f) => f.severity === "high").length;
      const mediumCount = staticFindings.filter((f) => f.severity === "medium").length;
      const lowCount = staticFindings.filter((f) => f.severity === "low").length;

      // Check plan limits for this installation
      const planLimits = await getInstallationLimits(installationId);

      // Run LLM analysis on candidate files (if enabled for this plan)
      const llmIssues: LlmIssue[] = [];

      // Build static findings summaries for LLM context
      const staticFindingSummaries: StaticFindingSummary[] = staticFindings.map((f) => ({
        ruleId: f.kind,
        kind: f.kind,
        file: f.file,
        line: f.line ?? 0,
        severity: f.severity === "high" ? "high" : f.severity === "medium" ? "medium" : "low",
        summary: f.message,
      }));

      try {
        // Skip LLM analysis if not enabled for this plan
        if (!planLimits.llmEnabled) {
          console.log(`[LLM] LLM analysis not enabled for this plan, skipping`);
        } else {
          const candidates = selectLlmCandidates(prFiles, staticFindings);
          if (!candidates.length) {
            console.log("[LLM] No LLM candidates selected for this PR");
          } else {
            console.log(`[LLM] Selected ${candidates.length} candidate patch(es) for analysis`);
          }

          for (const candidate of candidates) {
            // Filter static findings to those relevant to this candidate file
            const fileFindings = staticFindingSummaries.filter((f) => f.file === candidate.file);

            // Fetch full file content for deep analysis (Smart Funnel - Tier 2/3)
            let fullContent: string | undefined;
            let fileStructure: string | undefined;

            try {
              const content = await fetchFileContent(octokit, owner, repo, candidate.file, headSha);
              if (content) {
                // Redact secrets before sending to LLM
                fullContent = redactSecrets(content);
                // Generate structural summary for LLM context (use original for accurate structure)
                fileStructure = extractFileStructure(content, candidate.file);
                console.log(`[LLM] Generated structure for ${candidate.file}`);
              }
            } catch (fetchErr) {
              console.warn(`[LLM] Could not fetch full content for ${candidate.file}:`, fetchErr);
              // Continue with just the patch if full content fetch fails
            }

            const result = await analyzeSnippetWithLlm({
              file: candidate.file,
              language: candidate.language,
              snippet: candidate.patch,
              staticFindings: fileFindings,
              fullContent,
              fileStructure,
              installationId,
            });

            if (!result) {
              console.warn(`[LLM] Analysis skipped or failed for ${candidate.file} (result is null)`);
              continue;
            }

            for (const issue of result.issues) {
              llmIssues.push({
                ...issue,
              });
            }
          }
        } // end else (llmEnabled)
      } catch (err) {
        console.error("[LLM] Unexpected error during LLM analysis:", err instanceof Error ? err.message : "unknown error");
      }

      // Compute Vibe Score with config
      const llmIssueCount = llmIssues.length;
      const vibeScoreResult: VibeScoreResult = computeVibeScore({
        staticFindings,
        llmIssues,
        options: { scoringConfig: vibescanConfig.scoring },
      });
      const vibeScore = vibeScoreResult.score;
      const vibeLabel = vibeScoreResult.label;

      // Build summary
      let summary: string;
      if (!totalFindings && !llmIssueCount) {
        summary =
          `Vibe Score: ${vibeScore} (${vibeLabel}). ` +
          "No obvious vibe-coded production risks detected in this diff (static + AI heuristics).";
      } else {
        summary =
          `Vibe Score: ${vibeScore} (${vibeLabel}). ` +
          `Detected ${totalFindings} static potential risk area(s) (H:${highCount}, M:${mediumCount}, L:${lowCount}) and ${llmIssueCount} AI-identified issue(s). Review before merging to production.`;
      }

      // Generate executive summary using LLM (if findings exist)
      let executiveSummary: string | null = null;
      if (totalFindings > 0) {
        try {
          const summaryInput = prepareExecutiveSummaryInput(staticFindings, vibeScore, installationId);
          executiveSummary = await generateExecutiveSummary(summaryInput);
        } catch (err) {
          console.warn("[PR Check] Executive summary generation failed:", err instanceof Error ? err.message : "unknown");
        }
      }

      // Validate findings with LLM for confidence scoring (if enabled)
      let validatedFindings: ValidatedFinding[] | null = null;
      let validationFilteredCount = 0;
      if (totalFindings > 0 && vibescanConfig.llm.validate_findings) {
        try {
          console.log("[PR Check] Validating static findings with LLM...");
          const validationResult = await validateFindingsWithLlm({
            findings: staticFindingSummaries,
            codeContext: fileContents,
            installationId,
            confidenceThreshold: vibescanConfig.llm.confidence_threshold,
          });
          if (validationResult) {
            validatedFindings = validationResult.validatedFindings;
            validationFilteredCount = validationResult.filteredCount;
            console.log(
              `[PR Check] Validation complete: ${validatedFindings.length} findings, ` +
              `${validationFilteredCount} filtered as likely false positives, ` +
              `${validationResult.tokensUsed} tokens used`
            );
          }
        } catch (err) {
          console.warn("[PR Check] Finding validation failed:", err instanceof Error ? err.message : "unknown");
        }
      }

      // Build markdown details text
      let text = "";

      text += `## Vibe Score\n\n`;
      text += `**Score:** ${vibeScore} (${vibeLabel})\n\n`;

      // Add executive summary at the top if available
      if (executiveSummary) {
        text += `## Executive Summary\n\n`;
        text += `> ${executiveSummary}\n\n`;
      }

      // Group and display static findings (with confidence if validation succeeded)
      text += "## Static Analysis Findings\n\n";
      if (totalFindings) {
        if (validatedFindings) {
          // Use validated findings with confidence scores
          const groupedValidated = groupValidatedFindingsByKind(
            validatedFindings,
            vibescanConfig.llm.confidence_threshold
          );
          text += buildValidatedFindingsDisplay(groupedValidated, validationFilteredCount);
        } else {
          // Fall back to original grouping without confidence
          const groupedFindings = groupStaticFindingsByKind(staticFindings);
          text += buildGroupedFindingsDisplay(groupedFindings);
        }
      } else {
        text += "_No static issues detected in this diff._\n";
      }

      text += "\n\n## AI (LLM) analysis findings\n\n";

      // Filter LLM issues to exclude those that overlap with filtered static findings
      // This prevents showing "Hardcoded secrets" in LLM section when HARDCODED_SECRET was filtered
      const filteredLlmIssues = validatedFindings
        ? llmIssues.filter((issue) => {
            // If the LLM issue references a specific file, check if that file
            // has filtered findings that likely overlap with this issue type
            if (!issue.file) return true; // Keep cross-cutting issues without file reference

            // Build a set of files with filtered findings
            const filteredFiles = new Set(
              validatedFindings
                .filter((v) => v.likelyFalsePositive)
                .map((v) => v.file)
            );

            // If this file has filtered findings, check for overlap
            if (filteredFiles.has(issue.file)) {
              // Map LLM issue kinds to related static rule IDs
              const llmToStaticRuleMap: Record<string, string[]> = {
                ENVIRONMENT_ASSUMPTION: ["HARDCODED_SECRET", "HARDCODED_URL", "PROTOTYPE_INFRA"],
                DATA_CONTRACT_RISK: ["HARDCODED_SECRET", "UNVALIDATED_INPUT", "DATA_SHAPE_ASSUMPTION"],
                RESILIENCE_GAP: ["SILENT_ERROR", "UNSAFE_IO"],
                OBSERVABILITY_GAP: ["SILENT_ERROR"],
                SCALING_RISK: ["UNBOUNDED_QUERY", "MEMORY_RISK", "LOOPED_IO"],
                CONCURRENCY_RISK: ["SHARED_FILE_WRITE", "RETRY_STORM_RISK", "GLOBAL_MUTATION"],
              };

              const relatedStaticRules = llmToStaticRuleMap[issue.kind] || [];

              // Check if any filtered finding in this file matches a related rule
              const hasOverlappingFilteredFinding = validatedFindings.some(
                (v) => v.likelyFalsePositive && v.file === issue.file && relatedStaticRules.includes(v.ruleId)
              );

              if (hasOverlappingFilteredFinding) {
                console.log(`[PR Check] Filtering LLM issue "${issue.title}" - overlaps with filtered static finding in ${issue.file}`);
                return false;
              }
            }

            return true;
          })
        : llmIssues;

      const filteredLlmIssueCount = filteredLlmIssues.length;

      if (filteredLlmIssueCount) {
        // Group issues by kind for better organization
        const groupedIssues = groupIssuesByKind(filteredLlmIssues);
        let issuesShown = 0;
        const maxLlmToShow = 10;

        for (const [kind, issues] of groupedIssues) {
          if (issuesShown >= maxLlmToShow) break;

          const kindLabel = LLM_ISSUE_KIND_LABELS[kind];
          text += `### ${kindLabel}\n\n`;

          for (const issue of issues) {
            if (issuesShown >= maxLlmToShow) break;

            const severityBadge = issue.severity.toUpperCase();
            text += `- [${severityBadge}] **${issue.title}**: ${issue.summary}`;
            if (issue.suggestedFix) {
              text += ` _Fix:_ ${issue.suggestedFix}`;
            }
            text += "\n";
            issuesShown++;
          }
          text += "\n";
        }

        if (filteredLlmIssueCount > maxLlmToShow) {
          text += `_+ ${filteredLlmIssueCount - maxLlmToShow} more AI finding(s) not shown._\n`;
        }
      } else {
        text += "_No additional AI-identified issues beyond static analysis._\n";
      }

      // Add architecture risk summary - use filtered findings if validation succeeded
      const findingsForArchSummary = validatedFindings
        ? staticFindings.filter((f) => {
            const validated = validatedFindings.find(
              (v) => v.file === f.file && v.line === (f.line ?? 0) && v.ruleId === f.kind
            );
            return !validated?.likelyFalsePositive;
          })
        : staticFindings;
      const archSummary = computeArchitectureRiskSummary({ staticFindings: findingsForArchSummary, llmIssues: filteredLlmIssues });
      text += "\n\n" + buildArchitectureRiskSection(archSummary);

      // Create check run
      await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
        owner,
        repo,
        name: "Vibe Scale",
        head_sha: headSha,
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Vibe Scale static + AI analysis",
          summary,
          text,
        },
      });

      console.log(
        `[GitHub App] Created Vibe Scale check run with ${staticFindings.length} static finding(s) and ${llmIssueCount} AI finding(s) on ${owner}/${repo}@${headSha}`
      );

      // Post high-risk PR comment if there are high-severity findings (use filtered findings)
      const commentBody = buildHighRiskCommentBody({
        staticFindings: findingsForArchSummary,
        llmIssues: filteredLlmIssues,
        vibeScore,
        vibeLabel,
        archSummary,
      });

      if (commentBody) {
        try {
          await postHighRiskComment({
            octokit,
            owner,
            repo,
            pullNumber,
            body: commentBody,
          });
        } catch (err) {
          console.error("[GitHub App] Error while trying to post high-risk comment:", err instanceof Error ? err.message : "unknown error");
        }
      } else {
        console.log("[GitHub App] No high-risk findings; not posting PR comment.");
      }

      // Create GitHub issues for high-severity findings (if enabled)
      if (vibescanConfig.reporting.create_issues && staticFindings.length > 0) {
        try {
          const issuesCreated = await createIssuesForFindings({
            octokit,
            owner,
            repo,
            prNumber: pullNumber,
            prTitle: payload.pull_request.title,
            findings: staticFindings,
            config: vibescanConfig.reporting,
          });
          if (issuesCreated > 0) {
            console.log(`[GitHub App] Created ${issuesCreated} issue(s) for high-severity findings`);
          }
        } catch (err) {
          console.error("[GitHub App] Error creating issues:", err instanceof Error ? err.message : "unknown");
        }
      }
    } catch (error) {
      console.error("[GitHub App] Failed to create Vibe Scale check run:", error instanceof Error ? error.message : "unknown error");
    }
  });

  webhooks.on("check_suite", async ({ id, name, payload }) => {
    console.log(`[GitHub App] Received ${name} event (id: ${id}):`, payload.action);
  });

  // ============================================================================
  // Phase 2: Installation Baseline Scan
  // ============================================================================

  webhooks.on("installation.created", async ({ id, name, payload }) => {
    console.log(`[GitHub App] Received ${name} event (id: ${id}): App installed on ${payload.repositories?.length ?? 0} repository(ies)`);

    const installationId = payload.installation.id;
    const repositories = payload.repositories ?? [];

    // Get owner from account (handle both user and org)
    const account = payload.installation.account;
    const owner = account && "login" in account ? account.login : null;

    if (!owner) {
      console.warn("[GitHub App] Could not determine owner, skipping baseline scan");
      return;
    }

    if (!repositories.length) {
      console.log("[GitHub App] No repositories in installation event, skipping baseline scan");
      return;
    }

    // Process each repository
    for (const repo of repositories) {
      try {
        await performBaselineScan({
          installationId,
          owner,
          repoName: repo.name,
          repoFullName: repo.full_name,
        });
      } catch (error) {
        console.error(`[GitHub App] Baseline scan failed for ${repo.full_name}:`, error instanceof Error ? error.message : "unknown error");
      }
    }
  });

  // Handle when repos are added to existing installation
  webhooks.on("installation_repositories.added", async ({ id, name, payload }) => {
    console.log(`[GitHub App] Received ${name} event (id: ${id}): ${payload.repositories_added?.length ?? 0} repository(ies) added`);

    const installationId = payload.installation.id;
    const repositories = payload.repositories_added ?? [];

    const account = payload.installation.account;
    const owner = account && "login" in account ? account.login : null;

    if (!owner) {
      console.warn("[GitHub App] Could not determine owner, skipping baseline scan");
      return;
    }

    for (const repo of repositories) {
      try {
        await performBaselineScan({
          installationId,
          owner,
          repoName: repo.name,
          repoFullName: repo.full_name,
        });
      } catch (error) {
        console.error(`[GitHub App] Baseline scan failed for ${repo.full_name}:`, error instanceof Error ? error.message : "unknown error");
      }
    }
  });

  // Handle GitHub Marketplace purchase events for billing tiers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webhooks.on("marketplace_purchase" as any, async ({ id, name, payload }: { id: string; name: string; payload: MarketplacePurchasePayload }) => {
    console.log(`[GitHub App] Received marketplace_purchase event (id: ${id}): ${payload.action}`);

    try {
      await handleMarketplacePurchase(payload);
      // vibescale-ignore-next-line SILENT_ERROR - Webhook handlers should not propagate errors to prevent cascading failures
    } catch (error) {
      console.error("[GitHub App] Error handling marketplace purchase:", error instanceof Error ? error.message : "unknown error");
    }
  });

  console.log("[GitHub App] Event handlers registered");
}
