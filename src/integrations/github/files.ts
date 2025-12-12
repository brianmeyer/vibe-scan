/**
 * File content fetching, redaction, and LLM candidate selection.
 */

import { Octokit } from "octokit";
import { Finding } from "../../analysis/analyzer";
import { SECRET_PATTERNS } from "../../analysis/patterns";
import {
  MAX_FILE_SIZE_BYTES,
  CODE_FILE_EXTENSIONS,
  PrFilePatch,
  LlmCandidate,
} from "./types";

/**
 * Check if a file is a code file worth analyzing.
 */
export function isCodeFile(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  return CODE_FILE_EXTENSIONS.has(ext);
}

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
export async function fetchFileContent(
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

/**
 * Redact secrets from content before sending to LLM.
 * Replaces any text matching SECRET_PATTERNS with [REDACTED_SECRET].
 *
 * @param content - The content to redact secrets from
 * @returns Content with secrets replaced by [REDACTED_SECRET]
 */
export function redactSecrets(content: string): string {
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

/**
 * Determine language from filename extension.
 */
export function determineLanguageFromFilename(filename: string): string | undefined {
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

/**
 * Truncate a patch to a maximum number of characters.
 */
export function truncatePatch(patch: string, maxChars: number): string {
  if (patch.length <= maxChars) return patch;
  return patch.slice(0, maxChars) + "\n... [truncated]";
}

/**
 * Select candidate files for LLM analysis based on static findings severity.
 */
export function selectLlmCandidates(
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
