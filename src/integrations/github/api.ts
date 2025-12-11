/**
 * API endpoint for GitHub Actions integration.
 */

import { analyzePullRequestPatchesWithConfig, Finding } from "../../analysis/analyzer";
import { computeVibeScore } from "../../analysis/scoring";
import { CODE_EXTENSIONS } from "../../analysis/patterns";
import {
  StaticFindingSummary,
  validateFindingsWithLlm,
  ValidatedFinding,
  generateExecutiveSummary,
} from "../llm";
import { createInstallationOctokit, findInstallationForRepo } from "./client";
import { fetchRepoConfig } from "./config";
import { fetchFileContent } from "./files";
import { prepareExecutiveSummaryInput } from "./summary";
import { ApiAnalysisResult } from "./types";

/**
 * Analyze a pull request via API (for GitHub Actions integration).
 *
 * This is called by the lightweight GitHub Action to run analysis
 * using the server's API keys (SaaS model).
 */
export async function analyzeForApi(
  owner: string,
  repo: string,
  pullNumber: number
): Promise<ApiAnalysisResult> {
  console.log(`[API] Analyzing PR #${pullNumber} for ${owner}/${repo}`);

  // Find installation
  const installationId = await findInstallationForRepo(owner, repo);
  if (!installationId) {
    return {
      success: false,
      vibeScore: 0,
      vibeLabel: "error",
      findings: { total: 0, high: 0, medium: 0, low: 0, filtered: 0 },
      details: [],
      error: "Vibe Scan is not installed on this repository. Please install the GitHub App first.",
    };
  }

  const octokit = createInstallationOctokit(installationId);

  // Get PR details
  let pr;
  try {
    const prResponse = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: pullNumber,
    });
    pr = prResponse.data;
  } catch (error) {
    return {
      success: false,
      vibeScore: 0,
      vibeLabel: "error",
      findings: { total: 0, high: 0, medium: 0, low: 0, filtered: 0 },
      details: [],
      error: `Failed to fetch PR #${pullNumber}: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }

  // Fetch config
  const vibescanConfig = await fetchRepoConfig(
    octokit,
    owner,
    repo,
    pr.head.ref,
    pr.base.ref
  );

  // Get PR files
  const filesResponse = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const prFiles = filesResponse.data.map((f) => ({
    filename: f.filename,
    patch: f.patch,
  }));

  console.log(`[API] Found ${prFiles.length} changed files`);

  // Fetch file contents for context
  const fileContents = new Map<string, string>();
  const filesToFetch = prFiles
    .map((f) => f.filename)
    .filter((f) => CODE_EXTENSIONS.some((ext) => f.endsWith(ext)))
    .slice(0, 20);

  for (const filePath of filesToFetch) {
    const content = await fetchFileContent(octokit, owner, repo, filePath, pr.head.sha);
    if (content) {
      fileContents.set(filePath, content);
    }
  }

  // Run static analysis
  const staticFindings = analyzePullRequestPatchesWithConfig(prFiles, {
    config: vibescanConfig,
    fileContents,
  });

  console.log(`[API] Static analysis found ${staticFindings.length} findings`);

  // Convert to summary format
  const staticFindingSummaries: StaticFindingSummary[] = staticFindings.map((f) => ({
    ruleId: f.kind,
    kind: f.kind,
    file: f.file,
    line: f.line ?? 0,
    severity: f.severity === "high" ? "high" : f.severity === "medium" ? "medium" : "low",
    summary: f.message,
  }));

  // Validate findings with LLM
  let validatedFindings: ValidatedFinding[] | null = null;
  let filteredCount = 0;

  if (staticFindings.length > 0 && vibescanConfig.llm.validate_findings) {
    console.log("[API] Validating findings with LLM...");
    const validationResult = await validateFindingsWithLlm({
      findings: staticFindingSummaries,
      codeContext: fileContents,
      installationId,
      confidenceThreshold: vibescanConfig.llm.confidence_threshold,
    });

    if (validationResult) {
      validatedFindings = validationResult.validatedFindings;
      filteredCount = validationResult.filteredCount;
      console.log(`[API] Validated: ${filteredCount} filtered as false positives`);
    }
  }

  // Compute score (excluding filtered findings)
  const findingsForScore = validatedFindings
    ? staticFindings.filter((f) => {
        const validated = validatedFindings!.find(
          (v) => v.file === f.file && v.line === (f.line ?? 0) && v.ruleId === f.kind
        );
        return !validated?.likelyFalsePositive;
      })
    : staticFindings;

  const vibeScoreResult = computeVibeScore({
    staticFindings: findingsForScore,
    llmIssues: [],
    options: { scoringConfig: vibescanConfig.scoring },
  });

  // Count by severity
  const high = findingsForScore.filter((f) => f.severity === "high").length;
  const medium = findingsForScore.filter((f) => f.severity === "medium").length;
  const low = findingsForScore.filter((f) => f.severity === "low").length;

  // Generate executive summary
  let executiveSummary: string | undefined;
  if (findingsForScore.length > 0 && vibescanConfig.llm.enabled) {
    try {
      const summaryInput = prepareExecutiveSummaryInput(findingsForScore, vibeScoreResult.score, installationId);
      executiveSummary = await generateExecutiveSummary(summaryInput) ?? undefined;
    } catch {
      // Executive summary is optional
    }
  }

  // Build details array
  const details = validatedFindings
    ? validatedFindings.map((v) => ({
        ruleId: v.ruleId,
        file: v.file,
        line: v.line || null,
        severity: v.severity,
        message: v.summary,
        confidence: v.confidence,
        likelyFalsePositive: v.likelyFalsePositive,
      }))
    : staticFindings.map((f) => ({
        ruleId: f.kind,
        file: f.file,
        line: f.line || null,
        severity: f.severity,
        message: f.message,
      }));

  return {
    success: true,
    vibeScore: vibeScoreResult.score,
    vibeLabel: vibeScoreResult.label,
    findings: {
      total: findingsForScore.length,
      high,
      medium,
      low,
      filtered: filteredCount,
    },
    details,
    executiveSummary,
  };
}
