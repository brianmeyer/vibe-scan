/**
 * OpenAI/Groq client setup.
 */

import OpenAI from "openai";
import { config } from "../../env";

/**
 * Create an OpenAI client configured to use Groq's API.
 * Lazily created to avoid errors if GROQ_API_KEY is not set.
 */
export function createOpenAIClient(): OpenAI | null {
  if (!config.GROQ_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: config.GROQ_API_KEY,
    baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  });
}

/**
 * Create an OpenAI client, throwing if not configured.
 */
export function createOpenAIClientOrThrow(): OpenAI {
  const client = createOpenAIClient();
  if (!client) {
    throw new Error("GROQ_API_KEY not configured");
  }
  return client;
}
