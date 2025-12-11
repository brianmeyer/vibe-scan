/**
 * GitHub Action entry point for Vibe Scan.
 *
 * Runs vibe-scan analysis on pull requests and posts results.
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import { analyzePullRequestPatchesWithConfig, Finding } from "../analysis/analyzer";
import { computeVibeScore } from "../analysis/scoring";
import { createDefaultConfig } from "../config/loader";
import {
  validateFindingsWithLlm,
  StaticFindingSummary,
  ValidatedFinding,
} from "../integrations/llm";

// ============================================================================
// Main Action
// ============================================================================

async function run(): Promise<void> {
  try {
    // Get inputs
    const groqApiKey = core.getInput("groq-api-key");
    const confidenceThreshold = parseFloat(core.getInput("confidence-threshold") || "0.6");
    const failOnHigh = core.getInput("fail-on-high") === "true";
    const validateFindings = core.getInput("validate-findings") !== "false";

    // Set GROQ_API_KEY for LLM functions
    if (groqApiKey) {
      process.env.GROQ_API_KEY = groqApiKey;
    }

    // Get GitHub context
    const context = github.context;
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
      core.setFailed("GITHUB_TOKEN is required");
      return;
    }

    const octokit = github.getOctokit(token);

    // Only run on pull requests
    if (context.eventName !== "pull_request") {
      core.info("Vibe Scan only runs on pull_request events");
      return;
    }

    const pullNumber = context.payload.pull_request?.number;
    if (!pullNumber) {
      core.setFailed("Could not determine pull request number");
      return;
    }

    const owner = context.repo.owner;
    const repo = context.repo.repo;

    core.info(`Analyzing PR #${pullNumber} in ${owner}/${repo}...`);

    // Fetch PR files
    const filesResponse = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    const prFiles = filesResponse.data.map((f) => ({
      filename: f.filename,
      patch: f.patch,
    }));

    core.info(`Found ${prFiles.length} changed files`);

    // Load default config (could be extended to load .vibescan.yml)
    const config = createDefaultConfig();

    // Run static analysis
    const staticFindings = analyzePullRequestPatchesWithConfig(prFiles, {
      config,
      fileContents: new Map(),
    });

    core.info(`Static analysis found ${staticFindings.length} potential issues`);

    // Prepare findings for validation
    const staticFindingSummaries: StaticFindingSummary[] = staticFindings.map((f) => ({
      ruleId: f.kind,
      kind: f.kind,
      file: f.file,
      line: f.line ?? 0,
      severity: f.severity === "high" ? "high" : f.severity === "medium" ? "medium" : "low",
      summary: f.message,
    }));

    // Validate findings with LLM (if enabled and API key provided)
    let validatedFindings: ValidatedFinding[] | null = null;
    let filteredCount = 0;

    if (validateFindings && groqApiKey && staticFindings.length > 0) {
      core.info("Validating findings with LLM...");

      // Fetch file contents for context
      const fileContents = new Map<string, string>();
      const uniqueFiles = [...new Set(staticFindings.map((f) => f.file))];

      for (const filePath of uniqueFiles.slice(0, 10)) {
        try {
          const contentResponse = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: filePath,
            ref: context.payload.pull_request?.head.sha,
          });

          if ("content" in contentResponse.data && contentResponse.data.content) {
            const content = Buffer.from(contentResponse.data.content, "base64").toString("utf-8");
            fileContents.set(filePath, content);
          }
        } catch {
          // File might not exist or be too large
        }
      }

      const validationResult = await validateFindingsWithLlm({
        findings: staticFindingSummaries,
        codeContext: fileContents,
        confidenceThreshold,
      });

      if (validationResult) {
        validatedFindings = validationResult.validatedFindings;
        filteredCount = validationResult.filteredCount;
        core.info(`LLM validation: ${filteredCount} findings filtered as false positives`);
      }
    }

    // Compute vibe score (excluding filtered findings)
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
    });

    // Count findings
    const highCount = findingsForScore.filter((f) => f.severity === "high").length;
    const mediumCount = findingsForScore.filter((f) => f.severity === "medium").length;
    const lowCount = findingsForScore.filter((f) => f.severity === "low").length;

    // Set outputs
    core.setOutput("vibe-score", vibeScoreResult.score);
    core.setOutput("findings-count", findingsForScore.length);
    core.setOutput("high-count", highCount);
    core.setOutput("filtered-count", filteredCount);

    // Build summary
    let summary = `## Vibe Scan Results\n\n`;
    summary += `**Vibe Score:** ${vibeScoreResult.score}/100 (${vibeScoreResult.label})\n\n`;
    summary += `| Severity | Count |\n|----------|-------|\n`;
    summary += `| High | ${highCount} |\n`;
    summary += `| Medium | ${mediumCount} |\n`;
    summary += `| Low | ${lowCount} |\n\n`;

    if (filteredCount > 0) {
      summary += `_${filteredCount} finding(s) were filtered as likely false positives._\n\n`;
    }

    // Add findings details
    if (findingsForScore.length > 0) {
      summary += `### Top Issues\n\n`;

      const topFindings = findingsForScore
        .sort((a, b) => {
          const severityOrder = { high: 0, medium: 1, low: 2 };
          return severityOrder[a.severity] - severityOrder[b.severity];
        })
        .slice(0, 10);

      for (const finding of topFindings) {
        const severity = finding.severity.toUpperCase();
        const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
        summary += `- **[${severity}]** \`${location}\` - ${finding.kind}\n`;
      }

      if (findingsForScore.length > 10) {
        summary += `\n_...and ${findingsForScore.length - 10} more findings._\n`;
      }
    } else {
      summary += `No production risk issues detected.\n`;
    }

    // Post comment on PR
    const existingComments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
    });

    const botComment = existingComments.data.find(
      (comment) => comment.body?.includes("## Vibe Scan Results")
    );

    if (botComment) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: botComment.id,
        body: summary,
      });
      core.info("Updated existing Vibe Scan comment");
    } else {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: summary,
      });
      core.info("Posted Vibe Scan comment");
    }

    // Write job summary
    await core.summary
      .addHeading("Vibe Scan Results")
      .addRaw(`**Score:** ${vibeScoreResult.score}/100 (${vibeScoreResult.label})`)
      .addBreak()
      .addRaw(`**Findings:** ${findingsForScore.length} (${highCount} high, ${mediumCount} medium, ${lowCount} low)`)
      .write();

    // Fail if high-severity findings and fail-on-high is enabled
    if (failOnHigh && highCount > 0) {
      core.setFailed(`Found ${highCount} high-severity finding(s)`);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : "Unknown error");
  }
}

run();
