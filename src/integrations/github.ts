import { Webhooks } from "@octokit/webhooks";
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { config } from "../env";
import {
  analyzePullRequestPatchesWithConfig,
  Finding,
  analyzeRepository,
  BaselineAnalysisResult,
} from "../analysis/analyzer";
import {
  analyzeSnippetWithLlm,
  LlmAnalysisResult,
  LlmIssue,
  LLM_ISSUE_KIND_LABELS,
  groupIssuesByKind,
  StaticFindingSummary,
} from "./llm";
import { computeVibeScore, VibeScoreResult } from "../analysis/scoring";
import { createDefaultConfig, loadConfigFromString, LoadedConfig } from "../config/loader";
import { extractFileStructure } from "../analysis/structure";
import { SECRET_PATTERNS, CODE_EXTENSIONS } from "../analysis/patterns";
import { canAnalyzeWithAST } from "../analysis/ast";

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
// File Content Fetching
// ============================================================================

/** Maximum file size to fetch for LLM analysis (50KB) */
const MAX_FILE_SIZE_BYTES = 50 * 1024;

/**
 * Fetch the raw content of a file from the repository at a specific ref.
 * Enforces a size limit to prevent memory issues with large files.
 *
 * @param octokit - Authenticated Octokit instance
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param path - File path within the repository
 * @param ref - Git ref (SHA, branch, or tag)
 * @returns The file content as a string, or null if not found/too large/error
 */
async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    console.log(`[GitHub] Fetching file content: ${path} @ ${ref.slice(0, 7)}`);
    const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref,
    });

    const data = response.data as {
      content?: string;
      encoding?: string;
      type?: string;
      size?: number;
    };

    if (data.type !== "file") {
      console.log(`[GitHub] ${path} is not a file`);
      return null;
    }

    // Check file size before decoding to prevent memory issues
    if (data.size && data.size > MAX_FILE_SIZE_BYTES) {
      console.warn(
        `[GitHub] Skipping large file: ${path} (${Math.round(data.size / 1024)}KB > ${MAX_FILE_SIZE_BYTES / 1024}KB limit)`
      );
      return null;
    }

    if (!data.content) {
      console.log(`[GitHub] ${path} has no content`);
      return null;
    }

    // GitHub returns base64-encoded content for files
    const content = Buffer.from(data.content, "base64").toString("utf-8");

    // Double-check decoded size (base64 can be misleading)
    if (content.length > MAX_FILE_SIZE_BYTES) {
      console.warn(
        `[GitHub] Skipping large file after decode: ${path} (${Math.round(content.length / 1024)}KB)`
      );
      return null;
    }

    console.log(`[GitHub] Fetched ${path}: ${content.length} chars`);
    return content;
  } catch (error) {
    const err = error as { status?: number };
    if (err.status === 404) {
      console.log(`[GitHub] File not found: ${path}`);
    } else {
      console.warn(`[GitHub] Error fetching ${path}:`, error);
    }
    return null;
  }
}

// ============================================================================
// Secret Redaction
// ============================================================================

/**
 * Redact secrets from content before sending to LLM.
 * Replaces any text matching SECRET_PATTERNS with [REDACTED_SECRET].
 *
 * @param content - The content to redact secrets from
 * @returns Content with secrets replaced by [REDACTED_SECRET]
 */
function redactSecrets(content: string): string {
  let redacted = content;
  for (const pattern of SECRET_PATTERNS) {
    if (typeof pattern === "string") {
      // For string patterns, use simple replacement
      redacted = redacted.split(pattern).join("[REDACTED_SECRET]");
    } else {
      // For RegExp patterns, use global replacement
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
      redacted = redacted.replace(globalPattern, "[REDACTED_SECRET]");
    }
  }
  return redacted;
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

  let body = `🚨 **Vibe Scan Summary**\n\n`;
  body += `**Vibe Score: ${vibeScore} (${vibeLabel})**\n\n`;

  // Add compact architecture summary at the top
  if (archSummary) {
    const categories: { emoji: string; name: string; data: { count: number; topIssues: ArchIssue[] } }[] = [
      { emoji: "📈", name: "Scaling", data: archSummary.scaling },
      { emoji: "🔀", name: "Concurrency", data: archSummary.concurrency },
      { emoji: "⚠️", name: "Errors", data: archSummary.errorHandling },
      { emoji: "📋", name: "Data", data: archSummary.dataIntegrity },
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
 * A condensed issue for architecture summary display.
 */
interface ArchIssue {
  file: string;
  line?: number;
  snippet: string;
  kind: string;
}

/**
 * Categories for architecture risk summary.
 */
interface ArchitectureRiskSummary {
  scaling: { count: number; topIssues: ArchIssue[] };
  concurrency: { count: number; topIssues: ArchIssue[] };
  errorHandling: { count: number; topIssues: ArchIssue[] };
  dataIntegrity: { count: number; topIssues: ArchIssue[] };
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

/** Max top issues to show per category */
const MAX_TOP_ISSUES_PER_CATEGORY = 2;

/**
 * Human-readable descriptions for rule kinds.
 */
const RULE_DESCRIPTIONS: Record<string, string> = {
  UNBOUNDED_QUERY: "Query without limit",
  LOOPED_IO: "I/O call in loop (N+1)",
  MEMORY_RISK: "Loading large data into memory",
  GLOBAL_MUTATION: "Mutable global state",
  CHECK_THEN_ACT_RACE: "Race condition (check-then-act)",
  SILENT_ERROR: "Error swallowed silently",
  UNSAFE_IO: "Network call without error handling",
  STATEFUL_SERVICE: "In-memory state (breaks scaling)",
  PROTOTYPE_INFRA: "Non-production infrastructure",
  HARDCODED_SECRET: "Hardcoded credential",
  UNSAFE_EVAL: "Dynamic code execution",
  SCALING_RISK: "Scaling concern",
  CONCURRENCY_RISK: "Concurrency issue",
  RESILIENCE_GAP: "Missing fault tolerance",
  OBSERVABILITY_GAP: "Missing observability",
  DATA_CONTRACT_RISK: "Data validation issue",
  ENVIRONMENT_ASSUMPTION: "Environment-specific code",
};

/**
 * Compute an architecture risk summary from static findings and LLM issues.
 * Groups findings into risk categories and captures top issues for display.
 */
function computeArchitectureRiskSummary(params: {
  staticFindings: Finding[];
  llmIssues: LlmIssue[];
}): ArchitectureRiskSummary {
  const { staticFindings, llmIssues } = params;

  // Collect issues by category
  const scalingIssues: ArchIssue[] = [];
  const concurrencyIssues: ArchIssue[] = [];
  const errorHandlingIssues: ArchIssue[] = [];
  const dataIntegrityIssues: ArchIssue[] = [];

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
  };
}

/**
 * Build a markdown section for the architecture risk summary.
 * Shows top issues with locations, not just counts.
 */
function buildArchitectureRiskSection(summary: ArchitectureRiskSummary): string {
  let text = "## Architecture Risk Summary\n\n";

  const hasAnyRisks =
    summary.scaling.count > 0 ||
    summary.concurrency.count > 0 ||
    summary.errorHandling.count > 0 ||
    summary.dataIntegrity.count > 0;

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

      // Run LLM analysis on candidate files
      const llmResults: LlmAnalysisResult[] = [];
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
        console.error(`[GitHub App] Baseline scan failed for ${repo.full_name}:`, error);
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
        console.error(`[GitHub App] Baseline scan failed for ${repo.full_name}:`, error);
      }
    }
  });

  console.log("[GitHub App] Event handlers registered");
}

// ============================================================================
// Baseline Scan Implementation
// ============================================================================

const BASELINE_MAX_FILE_SIZE = 100 * 1024; // 100KB
const BASELINE_MAX_FILES = 200;

interface BaselineScanParams {
  installationId: number;
  owner: string;
  repoName: string;
  repoFullName: string;
}

/**
 * Perform baseline scan on a repository when the app is installed.
 * Creates an issue with the Vibe Score and findings.
 */
async function performBaselineScan(params: BaselineScanParams): Promise<void> {
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
    const vibescanConfig = await fetchRepoConfig(octokit, owner, repoName, defaultBranch, defaultBranch);

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
    // vibescan-ignore-next-line LOOPED_IO
    const fileContents = new Map<string, string>();
    const batchSize = 10;

    for (let i = 0; i < filesToAnalyze.length; i += batchSize) {
      const batch = filesToAnalyze.slice(i, i + batchSize);
      const promises = batch.map(async (file: { path?: string }) => {
        if (!file.path) return;
        try {
          const content = await fetchFileContent(octokit, owner, repoName, file.path, defaultBranch);
          if (content) {
            fileContents.set(file.path, content);
          }
        } catch (err) {
          // Individual file failures shouldn't stop the scan
          console.warn(`[Baseline] Failed to fetch ${file.path}:`, err);
        }
      });
      await Promise.all(promises);
    }

    console.log(`[Baseline] Fetched ${fileContents.size}/${filesToAnalyze.length} file(s)`);

    // Run analysis
    const baselineResult: BaselineAnalysisResult = analyzeRepository(fileContents, {
      config: vibescanConfig,
    });

    console.log(`[Baseline] Analysis complete: ${baselineResult.findings.length} findings in ${baselineResult.filesAnalyzed} files`);

    // Compute Vibe Score
    const vibeScoreResult = computeVibeScore({
      staticFindings: baselineResult.findings,
      llmIssues: [],
      options: { scoringConfig: vibescanConfig.scoring },
    });

    // Create issue
    const issueBody = buildBaselineIssueBody({
      vibeScore: vibeScoreResult.score,
      vibeLabel: vibeScoreResult.label,
      findings: baselineResult.findings,
      filesAnalyzed: baselineResult.filesAnalyzed,
      filesSkipped: baselineResult.filesSkipped,
      truncated: baselineResult.truncated,
      totalCodeFiles: codeFiles.length,
    });

    await octokit.request("POST /repos/{owner}/{repo}/issues", {
      owner,
      repo: repoName,
      title: `Vibe Scan Baseline: Score ${vibeScoreResult.score}/100 (${vibeScoreResult.label})`,
      body: issueBody,
      labels: ["vibe-scan", "baseline"],
    });

    console.log(`[Baseline] Created baseline issue for ${repoFullName}`);
  } catch (error) {
    console.error(`[Baseline] Error scanning ${repoFullName}:`, error);
    throw error; // Re-throw so caller knows it failed
  }
}

/**
 * Build markdown body for baseline scan issue.
 */
function buildBaselineIssueBody(params: {
  vibeScore: number;
  vibeLabel: string;
  findings: Finding[];
  filesAnalyzed: number;
  filesSkipped: number;
  truncated: boolean;
  totalCodeFiles: number;
}): string {
  const { vibeScore, vibeLabel, findings, filesAnalyzed, filesSkipped, truncated, totalCodeFiles } = params;

  let body = `# Vibe Scan Baseline Report\n\n`;
  body += `Welcome to Vibe Scan! This is your baseline production readiness assessment.\n\n`;

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
  body += `- **Issues Found:** ${findings.length}\n\n`;

  // Findings summary
  if (findings.length > 0) {
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
  body += `2. Configure Vibe Scan by adding a \`.vibescan.yml\` file\n`;
  body += `3. PRs will be analyzed automatically\n\n`;

  body += `---\n_Baseline scan from Vibe Scan installation._\n`;

  return body;
}
