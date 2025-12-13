/**
 * Executive summary generation using LLM.
 */

import OpenAI from "openai";
import { config } from "../../env";
import { isQuotaExceeded, recordTokenUsage } from "./quota";
import { withRetry } from "./retry";
import { buildExecutiveSummaryPrompt } from "./prompts";
import { ExecutiveSummaryInput, MODEL_BALANCED } from "./types";

/**
 * Generate an executive summary of findings using LLM.
 * Returns null if LLM is unavailable or quota exceeded.
 */
export async function generateExecutiveSummary(
  input: ExecutiveSummaryInput
): Promise<string | null> {
  // Check if API key is configured
  if (!config.GROQ_API_KEY) {
    console.warn("[LLM] GROQ_API_KEY not configured, skipping executive summary");
    return null;
  }

  // Check quota if installationId is provided
  if (input.installationId) {
    const quotaExceeded = await isQuotaExceeded(input.installationId);
    if (quotaExceeded) {
      console.warn("[LLM] Quota exceeded, skipping executive summary");
      return null;
    }
  }

  try {
    const client = new OpenAI({
      apiKey: config.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });

    const prompt = buildExecutiveSummaryPrompt(input);

    // Use retry logic for rate limit resilience
    // Use balanced model for summaries - better quality than 8B, cheaper than 120B
    const completion = await withRetry(() =>
      client.chat.completions.create({
        model: MODEL_BALANCED,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 256,
      })
    );

    // Record token usage
    if (input.installationId && completion.usage) {
      const totalTokens = completion.usage.total_tokens || 0;
      await recordTokenUsage(input.installationId, totalTokens);
      console.log(`[LLM] Executive summary used ${totalTokens} tokens`);
    }

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      console.warn("[LLM] Empty executive summary response");
      return null;
    }

    return content.trim();
  } catch (error) {
    // vibescan-ignore-next-line SILENT_ERROR - Intentional: LLM failure shouldn't block analysis
    console.error("[LLM] Executive summary generation failed:", error instanceof Error ? error.message : "unknown");
    return null;
  }
}
