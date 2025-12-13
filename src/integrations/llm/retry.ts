/**
 * Retry logic with exponential backoff.
 */

import { MAX_RETRIES, BASE_DELAY_MS } from "./types";

/**
 * Check if an error is likely transient and worth retrying.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Network errors, timeouts, rate limits, and server errors
    return (
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("socket") ||
      message.includes("rate limit") ||
      message.includes("429") ||
      message.includes("500") ||
      message.includes("502") ||
      message.includes("503") ||
      message.includes("504")
    );
  }
  return false;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic and exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  baseDelayMs: number = BASE_DELAY_MS
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    // vibecheck-ignore-next-line SILENT_ERROR
    } catch (error) {
      lastError = error;

      // Don't retry non-transient errors
      if (!isTransientError(error)) {
        throw error;
      }

      // Don't retry after the last attempt
      if (attempt === maxRetries) {
        console.error(`[LLM] All ${maxRetries + 1} attempts failed, giving up`);
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
      console.warn(
        `[LLM] Transient error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms:`,
        error instanceof Error ? error.message : "unknown"
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
