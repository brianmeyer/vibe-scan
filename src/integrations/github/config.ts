/**
 * Repository configuration fetching (.vibescale.yml).
 */

import { Octokit } from "octokit";
import { createDefaultConfig, loadConfigFromString, LoadedConfig } from "../../config/loader";
import { CONFIG_FILE_NAME } from "./types";

/**
 * Fetch the .vibescale.yml configuration from a repository.
 * Tries the PR head branch first, then falls back to the base branch.
 *
 * @param octokit - Authenticated Octokit instance
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param headRef - The PR head branch ref (e.g., "feature-branch")
 * @param baseRef - The PR base branch ref (e.g., "main")
 * @returns LoadedConfig (defaults if config file not found)
 */
export async function fetchRepoConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  headRef: string,
  baseRef: string
): Promise<LoadedConfig> {
  // Try to fetch from head branch first (allows PR to include config changes)
  // Only 2 refs to try - not a scaling issue
  const refsToTry = [headRef, baseRef];

  // vibescale-ignore-next-line MISSING_BATCHING,LOOPED_IO - Only 2 iterations max, not a scaling concern
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
