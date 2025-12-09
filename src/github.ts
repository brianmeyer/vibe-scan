import { Webhooks } from "@octokit/webhooks";
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { config } from "./config";
import { analyzePullRequestPatches, Finding } from "./analyzer";
import { analyzeSnippetWithLlm, LlmAnalysisResult, LlmIssue } from "./llm";
import { computeVibeScore, VibeScoreResult } from "./scoring";

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
  const highLlm = llmIssues.filter((i) => i.severity === 3);

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
      body += `- **(${issue.kind}) ${issue.title}** – ${issue.explanation}`;
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
// Event Handlers
// ============================================================================

export function registerEventHandlers(): void {
  webhooks.on("pull_request", async ({ id, name, payload }) => {
    console.log(`[GitHub App] Received ${name} event (id: ${id}):`, payload.action);

    const installationId = (payload as { installation?: { id: number } }).installation?.id;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const headSha = payload.pull_request.head.sha;
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

      // Run static analysis
      console.log(`[GitHub App] Analyzing ${prFiles.length} file(s)...`);
      const staticFindings = analyzePullRequestPatches(prFiles);

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

      // Compute Vibe Score
      const llmIssueCount = llmIssues.length;
      const vibeScoreResult: VibeScoreResult = computeVibeScore({
        staticFindings,
        llmIssues,
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
        const maxLlmToShow = 10;
        llmIssues.slice(0, maxLlmToShow).forEach((issue) => {
          text += `- [${issue.severity}] (${issue.kind}) ${issue.title}: ${issue.explanation}`;
          if (issue.suggestedFix) {
            text += ` Suggested fix: ${issue.suggestedFix}`;
          }
          text += "\n";
        });
        if (llmIssueCount > maxLlmToShow) {
          text += `\n_+ ${llmIssueCount - maxLlmToShow} more AI finding(s) not shown._\n`;
        }
      } else {
        text += "_No additional AI-identified issues beyond static analysis._\n";
      }

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
