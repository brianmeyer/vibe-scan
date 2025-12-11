/**
 * GitHub API client creation and authentication.
 */

import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { config } from "../../env";

/**
 * Create an Octokit client authenticated as an installation.
 */
export function createInstallationOctokit(installationId: number): Octokit {
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

/**
 * Create an App-authenticated Octokit for finding installations.
 */
export function createAppOctokit(): Octokit {
  if (!config.GITHUB_APP_ID || !config.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID or GITHUB_PRIVATE_KEY not set in config");
  }

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(config.GITHUB_APP_ID),
      privateKey: config.GITHUB_PRIVATE_KEY,
    },
  });
}

/**
 * Find the installation ID for a repository.
 */
export async function findInstallationForRepo(owner: string, repo: string): Promise<number | null> {
  try {
    const appOctokit = createAppOctokit();
    const response = await appOctokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
    });
    return response.data.id;
  } catch (error) {
    const err = error as { status?: number };
    if (err.status === 404) {
      return null; // App not installed on this repo
    }
    throw error;
  }
}
