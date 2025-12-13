/**
 * Main LLM analysis function.
 */

import { config } from "../../env";
import { createOpenAIClient } from "./client";
import { isQuotaExceeded, recordTokenUsage } from "./quota";
import { withRetry } from "./retry";
import { buildVibePrompt } from "./prompts";
import { attemptJsonRepair, validateAndNormalize } from "./parsing";
import { LlmAnalysisResult, StaticFindingSummary } from "./types";

/**
 * Analyze a code snippet using the LLM.
 *
 * @param params - Analysis parameters
 * @returns LlmAnalysisResult or null if LLM is unavailable/fails/quota exceeded
 */
export async function analyzeSnippetWithLlm(params: {
  file: string;
  language?: string;
  snippet: string;
  diffContext?: string;
  modelName?: string;
  staticFindings?: StaticFindingSummary[];
  fileStructure?: string;
  fullContent?: string;
  installationId?: number;
}): Promise<LlmAnalysisResult | null> {
  // Check if API key is configured
  if (!config.GROQ_API_KEY) {
    console.warn("[LLM] GROQ_API_KEY not configured, skipping LLM analysis");
    return null;
  }

  // Check quota if installationId is provided
  if (params.installationId) {
    const exceeded = await isQuotaExceeded(params.installationId);
    if (exceeded) {
      console.warn(`[LLM] Quota exceeded for installation ${params.installationId}, skipping LLM analysis`);
      return null;
    }
  }

  const openai = createOpenAIClient();
  if (!openai) {
    console.warn("[LLM] Failed to create OpenAI client");
    return null;
  }

  const model = params.modelName || "llama-3.1-8b-instant";
  const prompt = buildVibePrompt({
    file: params.file,
    language: params.language,
    snippet: params.snippet,
    diffContext: params.diffContext,
    staticFindings: params.staticFindings,
    fileStructure: params.fileStructure,
    fullContent: params.fullContent,
  });

  try {
    // Wrap API call with retry logic for transient failures
    const completion = await withRetry(() =>
      openai.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 4096,
      })
    );

    // Record token usage if installationId is provided
    if (params.installationId && completion.usage) {
      const totalTokens = completion.usage.total_tokens || 0;
      await recordTokenUsage(params.installationId, totalTokens);
      console.log(`[LLM] Recorded ${totalTokens} tokens for installation ${params.installationId}`);
    }

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      console.warn("[LLM] Empty response from model");
      return {
        issues: [],
        architectureSummary: undefined,
      };
    }

    // Parse JSON response
    let parsed: unknown;
    try {
      // Try to extract JSON from the response (in case there's extra text)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : content;
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      // Attempt to repair truncated JSON response
      const repaired = attemptJsonRepair(content);
      if (repaired) {
        try {
          parsed = JSON.parse(repaired);
          console.warn("[LLM] Successfully repaired truncated JSON response");
        // vibescale-ignore-next-line SILENT_ERROR
        } catch (repairError) {
          // Repair failed, log both errors and return empty
          console.error("[LLM] Failed to parse JSON response:", parseError instanceof Error ? parseError.message : "unknown");
          console.error("[LLM] Repair also failed:", repairError instanceof Error ? repairError.message : "unknown");
          // Truncate response to avoid logging potentially echoed secrets
          const truncated = content.length > 200 ? content.slice(0, 200) + "...[truncated]" : content;
          console.error("[LLM] Raw response (truncated):", truncated);
          return {
            issues: [],
            architectureSummary: undefined,
          };
        }
      } else {
        console.error("[LLM] Failed to parse JSON response:", parseError instanceof Error ? parseError.message : "unknown");
        // Truncate response to avoid logging potentially echoed secrets
        const truncated = content.length > 200 ? content.slice(0, 200) + "...[truncated]" : content;
        console.error("[LLM] Raw response (truncated):", truncated);
        return {
          issues: [],
          architectureSummary: undefined,
        };
      }
    }

    // Validate and normalize the response
    return validateAndNormalize(parsed, params.file);
  } catch (error) {
    console.error("[LLM] API call failed:", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}
