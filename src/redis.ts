/**
 * Redis client singleton for Vibe Scan.
 * Used for token quota tracking per installation.
 */

import Redis from "ioredis";
import { config } from "./env";

let redisClient: Redis | null = null;

/**
 * Get the Redis client singleton.
 * Returns null if Redis is not configured.
 */
export function getRedisClient(): Redis | null {
  if (!config.REDIS_URL) {
    return null;
  }

  if (!redisClient) {
    console.log("[Redis] Connecting to Redis...");

    redisClient = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) {
          console.error("[Redis] Max retries reached");
          return null;
        }
        return Math.min(times * 1000, 5000);
      },
    });

    redisClient.on("connect", () => {
      console.log("[Redis] Connected");
    });

    redisClient.on("error", (err) => {
      console.error("[Redis] Error:", err.message);
    });
  }

  return redisClient;
}

/**
 * Close the Redis connection gracefully.
 */
export async function closeRedisConnection(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
