/**
 * Token quota management using Redis.
 */

import { config } from "../../env";
import { getRedisClient } from "../../redis";
import { QUOTA_KEY_EXPIRY_SECONDS } from "./types";

/**
 * Generate the Redis key for an installation's monthly token usage.
 */
function getQuotaKey(installationId: number): string {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `vibe:usage:${installationId}:${yearMonth}`;
}

/**
 * Check if an installation has exceeded their monthly token quota.
 */
export async function isQuotaExceeded(installationId: number): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) {
    // No Redis = no quota enforcement
    return false;
  }

  try {
    const key = getQuotaKey(installationId);
    const usage = await redis.get(key);
    const currentUsage = usage ? parseInt(usage, 10) : 0;
    const limit = config.MONTHLY_TOKEN_QUOTA;

    if (currentUsage >= limit) {
      console.warn(`[LLM] Quota exceeded for installation ${installationId}: ${currentUsage}/${limit} tokens`);
      return true;
    }
    return false;
  } catch (error) {
    console.error("[LLM] Error checking quota:", error);
    return false; // Fail open
  }
}

/**
 * Record token usage for an installation.
 */
export async function recordTokenUsage(installationId: number, tokens: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const key = getQuotaKey(installationId);
    await redis.incrby(key, tokens);
    await redis.expire(key, QUOTA_KEY_EXPIRY_SECONDS);
  } catch (error) {
    console.error("[LLM] Error recording token usage:", error);
  }
}

/**
 * Get current token usage for an installation.
 */
export async function getTokenUsage(installationId: number): Promise<number> {
  const redis = getRedisClient();
  if (!redis) return 0;

  try {
    const key = getQuotaKey(installationId);
    const usage = await redis.get(key);
    return usage ? parseInt(usage, 10) : 0;
  } catch (error) {
    console.error("[LLM] Error getting token usage:", error);
    return 0;
  }
}
