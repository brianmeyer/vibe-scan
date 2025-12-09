import { Webhooks } from "@octokit/webhooks";
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { config } from "./config";
import { analyzePullRequestPatchesWithConfig, Finding } from "./analyzer";
import {
  analyzeSnippetWithLlm,
  LlmAnalysisResult,
  LlmIssue,
  LLM_ISSUE_KIND_LABELS,
  groupIssuesByKind,
} from "./llm";
import { computeVibeScore, VibeScoreResult } from "./scoring";
import { createDefaultConfig, loadConfigFromString, LoadedConfig } from "./config/loadConfig";

export const webhooks = new Webhooks({
  secret: config.GITHUB_WEBHOOK_SECRET || "development-secret",
});

function createInstallationOctokit(installationId: number): Octokit {
  if (!config.GITHUB_APP_ID || !config.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID or GITHUB_PRIVATE_KEY not set in config");
  }

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(config.GITHUB_APP_ID),
      privateKey: config.GITHUB_PRIVATE_KEY,
      installationId,
    },
  });
}

// ============================================================================
// Config Fetching
// ============================================================================

const CONFIG_FILE_NAME = ".vibescan.yml";

/**
 * Fetch the .vibescan.yml configuration from a repository.
 * Tries the PR head branch first, then falls back to the base branch.
 *
 * @param octokit - Authenticated Octokit instance
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param headRef - The PR head branch ref (e.g., "feature-branch")
 * @param baseRef - The PR base branch ref (e.g., "main")
 * @returns LoadedConfig (defaults if config file not found)
 */
async function fetchRepoConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  headRef: string,
  baseRef: string
): Promise<LoadedConfig> {
  // Try to fetch from head branch first (allows PR to include config changes)
  const refsToTry = [headRef, baseRef];

  for (const ref of refsToTry) {
    try {
      console.log(`[Config] Attempting to fetch ${CONFIG_FILE_NAME} from ref: ${ref}`);
      const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: CONFIG_FILE_NAME,
        ref,
      });

      // GitHub returns base64-encoded content for files
      const data = response.data as { content?: string; encoding?: string; type?: string };

      if (data.type !== "file" || !data.content) {
        console.log(`[Config] ${CONFIG_FILE_NAME} is not a file at ref ${ref}, trying next`);
        continue;
      }

      // Decode base64 content
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      console.log(`[Config] Successfully loaded ${CONFIG_FILE_NAME} from ref: ${ref}`);

      return loadConfigFromString(content);
    } catch (error) {
      const err = error as { status?: number };
      if (err.status === 404) {
        console.log(`[Config] ${CONFIG_FILE_NAME} not found at ref: ${ref}`);
        continue;
      }
      // Log other errors but don't fail - fall back to defaults
      console.warn(`[Config] Error fetching ${CONFIG_FILE_NAME} from ref ${ref}:`, error);
    }
  }

  console.log(`[Config] No ${CONFIG_FILE_NAME} found, using defaults`);
  return createDefaultConfig();
}

// ============================================================================
// LLM Candidate Selection
// ============================================================================

interface PrFilePatch {
  filename: string;
  patch?: string | null;
}

interface LlmCandidate {
  file: string;
  patch: string;
  language?: string;
}

function determineLanguageFromFilename(filename: string): string | undefined {
  if (filename.endsWith(".ts")) return "TypeScript";
  if (filename.endsWith(".tsx")) return "TSX";
  if (filename.endsWith(".js")) return "JavaScript";
  if (filename.endsWith(".jsx")) return "JSX";
  if (filename.endsWith(".py")) return "Python";
  if (filename.endsWith(".go")) return "Go";
  if (filename.endsWith(".rb")) return "Ruby";
  if (filename.endsWith(".java")) return "Java";
  if (filename.endsWith(".cs")) return "CSharp";
  return undefined;
}

function selectLlmCandidates(
  files: PrFilePatch[],
  findings: Finding[],
  maxCandidates: number = 3
): LlmCandidate[] {
  if (!findings.length) return [];

  // Rank files by maximum static severity within that file
  const severityScoreByFile = new Map<string, number>();

  for (const f of findings) {
    const current = severityScoreByFile.get(f.file) ?? 0;
    const severityScore = f.severity === "high" ? 3 : f.severity === "medium" ? 2 : 1;
    severityScoreByFile.set(f.file, Math.max(current, severityScore));
  }

  // Sort files by severity (high -> low)
  const sortedFiles = Array.from(severityScoreByFile.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file);

  const candidates: LlmCandidate[] = [];

  for (const filename of sortedFiles) {
    if (candidates.length >= maxCandidates) break;
    const filePatch = files.find((f) => f.filename === filename);
    if (!filePatch || !filePatch.patch) continue;

    const patch = filePatch.patch;
    if (!patch.trim()) continue;

    candidates.push({
      file: filename,
      patch: truncatePatch(patch, 2000), // keep patch size reasonable
      language: determineLanguageFromFilename(filename),
    });
  }

  return candidates;
}

function truncatePatch(patch: string, maxChars: number): string {
  if (patch.length <= maxChars) return patch;
  return patch.slice(0, maxChars) + "\n... [truncated]";
}

// ============================================================================
// High-Risk PR Comment Helpers
// ============================================================================

function buildHighRiskCommentBody(params: {
  staticFindings: Finding[];
  llmIssues: LlmIssue[];
  vibeScore: number;
  vibeLabel: string;
}): string | null {
  const { staticFindings, llmIssues, vibeScore, vibeLabel } = params;

  const highStatic = staticFindings.filter((f) => f.severity === "high");
  const highLlm = llmIssues.filter((i) => i.severity === "high");

  if (highStatic.length === 0 && highLlm.length === 0) {
    return null;
  }

  let body = `🚨 **Vibe Scan high-risk summary**\n\n`;
  body += `Vibe Score: **${vibeScore} (${vibeLabel})**\n\n`;
  body += `These findings look risky for production and deserve extra attention before merging.\n\n`;

  if (highStatic.length) {
    body += `### ⚠️ Static analysis high-risk findings\n\n`;
    highStatic.slice(0, 5).forEach((f) => {
      const location = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      body += `- ${location} **(${f.kind})** – ${f.message}\n`;
    });
    if (highStatic.length > 5) {
      body += `\n…and ${highStatic.length - 5} more static high-risk finding(s).\n`;
    }
    body += `\n`;
  }

  if (highLlm.length) {
    body += `### 🤖 AI (LLM) high-risk findings\n\n`;
    highLlm.slice(0, 5).forEach((issue) => {
      const kindLabel = LLM_ISSUE_KIND_LABELS[issue.kind];
      body += `- **(${kindLabel}) ${issue.title}** – ${issue.summary}`;
      if (issue.suggestedFix) {
        body += ` 💡 _Suggested fix:_ ${issue.suggestedFix}`;
      }
      body += `\n`;
    });
    if (highLlm.length > 5) {
      body += `\n…and ${highLlm.length - 5} more AI high-risk issue(s).\n`;
    }
  }

  body += `\n---\n`;
  body += `_(Vibe Scan combines static checks + AI analysis. Treat this as an advisory production-risk review.)_`;

  return body;
}

async function postHighRiskComment(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  body: string;
}) {
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
    console.error("[GitHub App] Failed to post high-risk summary comment:", err);
  }
}

// ============================================================================
// Architecture Risk Summary
// ============================================================================

/**
 * Categories for architecture risk summary.
 */
interface ArchitectureRiskSummary {
  scaling: { count: number; kinds: string[] };
  concurrency: { count: number; kinds: string[] };
  errorHandling: { count: number; kinds: string[] };
  dataIntegrity: { count: number; kinds: string[] };
}

/**
 * Sets for categorizing findings by architecture risk area.
 */
const SCALING_KINDS = new Set([
  "UNBOUNDED_QUERY",
  "UNBOUNDED_COLLECTION_PROCESSING",
  "MISSING_BATCHING",
  "NO_CACHING",
  "MEMORY_RISK",
  "LOOPED_IO",
]);

const CONCURRENCY_KINDS = new Set([
  "SHARED_FILE_WRITE",
  "RETRY_STORM_RISK",
  "BUSY_WAIT_OR_TIGHT_LOOP",
  "CHECK_THEN_ACT_RACE",
  "GLOBAL_MUTATION",
  "CONCURRENCY_RISK",
]);

const ERROR_HANDLING_KINDS = new Set([
  "UNSAFE_IO",
  "SILENT_ERROR",
  "MISSING_ERROR_HANDLING",
  "ASYNC_MISUSE",
]);

const DATA_INTEGRITY_KINDS = new Set([
  "UNVALIDATED_INPUT",
  "DATA_SHAPE_ASSUMPTION",
  "MIXED_RESPONSE_SHAPES",
  "HIDDEN_ASSUMPTIONS",
]);

/**
 * Compute an architecture risk summary from static findings and LLM issues.
 * Groups findings into risk categories for cross-file analysis.
 */
function computeArchitectureRiskSummary(params: {
  staticFindings: Finding[];
  llmIssues: LlmIssue[];
}): ArchitectureRiskSummary {
  const { staticFindings, llmIssues } = params;

  const summary: ArchitectureRiskSummary = {
    scaling: { count: 0, kinds: [] },
    concurrency: { count: 0, kinds: [] },
    errorHandling: { count: 0, kinds: [] },
    dataIntegrity: { count: 0, kinds: [] },
  };

  const scalingKindsFound = new Set<string>();
  const concurrencyKindsFound = new Set<string>();
  const errorHandlingKindsFound = new Set<string>();
  const dataIntegrityKindsFound = new Set<string>();

  // Categorize static findings
  for (const f of staticFindings) {
    if (SCALING_KINDS.has(f.kind)) {
      summary.scaling.count++;
      scalingKindsFound.add(f.kind);
    } else if (CONCURRENCY_KINDS.has(f.kind)) {
      summary.concurrency.count++;
      concurrencyKindsFound.add(f.kind);
    } else if (ERROR_HANDLING_KINDS.has(f.kind)) {
      summary.errorHandling.count++;
      errorHandlingKindsFound.add(f.kind);
    } else if (DATA_INTEGRITY_KINDS.has(f.kind)) {
      summary.dataIntegrity.count++;
      dataIntegrityKindsFound.add(f.kind);
    }
  }

  // Categorize LLM issues using the new simplified kind system
  for (const issue of llmIssues) {
    switch (issue.kind) {
      case "SCALING_RISK":
        summary.scaling.count++;
        scalingKindsFound.add(issue.kind);
        break;
      case "CONCURRENCY_RISK":
        summary.concurrency.count++;
        concurrencyKindsFound.add(issue.kind);
        break;
      case "RESILIENCE_GAP":
      case "OBSERVABILITY_GAP":
        // Resilience and observability map to error handling
        summary.errorHandling.count++;
        errorHandlingKindsFound.add(issue.kind);
        break;
      case "DATA_CONTRACT_RISK":
        summary.dataIntegrity.count++;
        dataIntegrityKindsFound.add(issue.kind);
        break;
      case "ENVIRONMENT_ASSUMPTION":
        // Environment assumptions often manifest as scaling issues
        summary.scaling.count++;
        scalingKindsFound.add(issue.kind);
        break;
    }
  }

  summary.scaling.kinds = Array.from(scalingKindsFound);
  summary.concurrency.kinds = Array.from(concurrencyKindsFound);
  summary.errorHandling.kinds = Array.from(errorHandlingKindsFound);
  summary.dataIntegrity.kinds = Array.from(dataIntegrityKindsFound);

  return summary;
}

/**
 * Build a markdown section for the architecture risk summary.
 */
function buildArchitectureRiskSection(summary: ArchitectureRiskSummary): string {
  let text = "## Architecture Risk Summary\n\n";
  text += "Cross-file analysis of production risk patterns:\n\n";

  const hasAnyRisks =
    summary.scaling.count > 0 ||
    summary.concurrency.count > 0 ||
    summary.errorHandling.count > 0 ||
    summary.dataIntegrity.count > 0;

  if (!hasAnyRisks) {
    text += "_No major architectural risk patterns detected across this PR._\n";
    return text;
  }

  if (summary.scaling.count > 0) {
    text += `| **Scaling** | ${summary.scaling.count} issue(s) | ${summary.scaling.kinds.join(", ")} |\n`;
  }
  if (summary.concurrency.count > 0) {
    text += `| **Concurrency** | ${summary.concurrency.count} issue(s) | ${summary.concurrency.kinds.join(", ")} |\n`;
  }
  if (summary.errorHandling.count > 0) {
    text += `| **Error Handling** | ${summary.errorHandling.count} issue(s) | ${summary.errorHandling.kinds.join(", ")} |\n`;
  }
  if (summary.dataIntegrity.count > 0) {
    text += `| **Data Integrity** | ${summary.dataIntegrity.count} issue(s) | ${summary.dataIntegrity.kinds.join(", ")} |\n`;
  }

  text += "\n";
  return text;
}

// ============================================================================
// Event Handlers
// ============================================================================

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

      // Fetch repository configuration (.vibescan.yml)
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

      console.log(`[GitHub App] Analyzing ${prFiles.length} file(s)...`);
      const staticFindings = analyzePullRequestPatchesWithConfig(prFiles, { config: vibescanConfig });

      // Compute static stats
      const totalFindings = staticFindings.length;
      const highCount = staticFindings.filter((f) => f.severity === "high").length;
      const mediumCount = staticFindings.filter((f) => f.severity === "medium").length;
      const lowCount = staticFindings.filter((f) => f.severity === "low").length;

      // Run LLM analysis on candidate files
      const llmResults: LlmAnalysisResult[] = [];
      const llmIssues: LlmIssue[] = [];

      try {
        const candidates = selectLlmCandidates(prFiles, staticFindings);
        if (!candidates.length) {
          console.log("[LLM] No LLM candidates selected for this PR");
        } else {
          console.log(`[LLM] Selected ${candidates.length} candidate patch(es) for analysis`);
        }

        for (const candidate of candidates) {
          const result = await analyzeSnippetWithLlm({
            file: candidate.file,
            language: candidate.language,
            snippet: candidate.patch,
          });

          if (!result) {
            console.warn(`[LLM] Analysis skipped or failed for ${candidate.file} (result is null)`);
            continue;
          }

          llmResults.push(result);
          for (const issue of result.issues) {
            llmIssues.push({
              ...issue,
            });
          }
        }
      } catch (err) {
        console.error("[LLM] Unexpected error during LLM analysis:", err);
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

      // Build markdown details text
      let text = "";

      text += `## Vibe Score\n\n`;
      text += `**Score:** ${vibeScore} (${vibeLabel})\n\n`;

      if (totalFindings) {
        text += "## Static analysis findings\n\n";
        const maxStaticToShow = 10;
        staticFindings.slice(0, maxStaticToShow).forEach((f) => {
          text += `- [${f.severity.toUpperCase()}] ${f.file}${f.line ? `:${f.line}` : ""} (${f.kind}): ${f.message}\n`;
        });
        if (totalFindings > maxStaticToShow) {
          text += `\n_+ ${totalFindings - maxStaticToShow} more static finding(s) not shown._\n`;
        }
      } else {
        text += "## Static analysis findings\n\n";
        text += "_No static issues detected in this diff._\n";
      }

      text += "\n\n## AI (LLM) analysis findings\n\n";

      if (llmIssueCount) {
        // Group issues by kind for better organization
        const groupedIssues = groupIssuesByKind(llmIssues);
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

        if (llmIssueCount > maxLlmToShow) {
          text += `_+ ${llmIssueCount - maxLlmToShow} more AI finding(s) not shown._\n`;
        }
      } else {
        text += "_No additional AI-identified issues beyond static analysis._\n";
      }

      // Add architecture risk summary
      const archSummary = computeArchitectureRiskSummary({ staticFindings, llmIssues });
      text += "\n\n" + buildArchitectureRiskSection(archSummary);

      // Create check run
      await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
        owner,
        repo,
        name: "Vibe Scan",
        head_sha: headSha,
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Vibe Scan static + AI analysis",
          summary,
          text,
        },
      });

      console.log(
        `[GitHub App] Created Vibe Scan check run with ${staticFindings.length} static finding(s) and ${llmIssueCount} AI finding(s) on ${owner}/${repo}@${headSha}`
      );

      // Post high-risk PR comment if there are high-severity findings
      const commentBody = buildHighRiskCommentBody({
        staticFindings,
        llmIssues,
        vibeScore,
        vibeLabel,
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
          console.error("[GitHub App] Error while trying to post high-risk comment:", err);
        }
      } else {
        console.log("[GitHub App] No high-risk findings; not posting PR comment.");
      }
    } catch (error) {
      console.error("[GitHub App] Failed to create Vibe Scan check run:", error);
    }
  });

  webhooks.on("check_suite", async ({ id, name, payload }) => {
    console.log(`[GitHub App] Received ${name} event (id: ${id}):`, payload.action);
  });

  console.log("[GitHub App] Event handlers registered");
}
