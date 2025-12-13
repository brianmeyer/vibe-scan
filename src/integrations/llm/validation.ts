/**
 * LLM-based validation of static findings with confidence scoring.
 */

import OpenAI from "openai";
import { config } from "../../env";
import { isQuotaExceeded, recordTokenUsage } from "./quota";
import { withRetry } from "./retry";
import { buildValidationPrompt } from "./prompts";
import {
  ValidateFindingsInput,
  ValidateFindingsResult,
  ValidatedFinding,
  MAX_FINDINGS_PER_CALL,
} from "./types";

/**
 * Validate static findings with LLM to filter false positives and assign confidence scores.
 *
 * This is the key function for implementing broad static detection + LLM filtering.
 * It takes static findings and returns them with confidence scores, allowing the
 * display layer to filter or highlight based on confidence.
 */
export async function validateFindingsWithLlm(
  input: ValidateFindingsInput
): Promise<ValidateFindingsResult | null> {
  const { findings, codeContext, installationId, confidenceThreshold = 0.6 } = input;

  // Check if API key is configured
  if (!config.GROQ_API_KEY) {
    console.warn("[LLM] GROQ_API_KEY not configured, skipping finding validation");
    return null;
  }

  // Check quota if installationId is provided
  if (installationId) {
    const quotaExceeded = await isQuotaExceeded(installationId);
    if (quotaExceeded) {
      console.warn("[LLM] Quota exceeded, skipping finding validation");
      return null;
    }
  }

  // Nothing to validate
  if (findings.length === 0) {
    return {
      validatedFindings: [],
      filteredCount: 0,
      tokensUsed: 0,
    };
  }

  // Cap findings to avoid token explosion (process in batches if needed)
  const cappedFindings = findings.slice(0, MAX_FINDINGS_PER_CALL);

  if (findings.length > MAX_FINDINGS_PER_CALL) {
    console.warn(`[LLM] Capping validation to ${MAX_FINDINGS_PER_CALL} findings (${findings.length} total)`);
  }

  try {
    const client = new OpenAI({
      apiKey: config.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });

    const prompt = buildValidationPrompt(cappedFindings, codeContext);

    // Use retry logic for rate limit resilience
    const completion = await withRetry(() =>
      client.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 2048,
      })
    );

    const tokensUsed = completion.usage?.total_tokens || 0;

    // Record token usage
    if (installationId) {
      await recordTokenUsage(installationId, tokensUsed);
      console.log(`[LLM] Finding validation used ${tokensUsed} tokens`);
    }

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      console.warn("[LLM] Empty validation response");
      return null;
    }

    // Parse JSON response - try multiple extraction methods
    let parsed: unknown;
    try {
      // Method 1: Try to find JSON array directly
      let jsonStr = content;

      // Method 2: Extract from markdown code block
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      } else {
        // Method 3: Find JSON array pattern
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
      }

      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error("[LLM] Failed to parse validation response:", parseError instanceof Error ? parseError.message : "unknown");
      // Log truncated response for debugging
      const truncated = content.length > 500 ? content.slice(0, 500) + "...[truncated]" : content;
      console.error("[LLM] Raw response:", truncated);
      return null;
    }

    if (!Array.isArray(parsed)) {
      console.warn("[LLM] Invalid validation response structure - expected array, got:", typeof parsed);
      return null;
    }

    console.log(`[LLM] Successfully parsed ${parsed.length} validation results`);

    // Build a map of validation results
    const validationMap = new Map<string, { confidence: number; reasoning?: string }>();
    for (const item of parsed) {
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (typeof obj.id === "string" && typeof obj.confidence === "number") {
          validationMap.set(obj.id, {
            confidence: Math.max(0, Math.min(1, obj.confidence)),
            reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
          });
        }
      }
    }

    // Map findings to validated findings
    const validatedFindings: ValidatedFinding[] = [];
    let filteredCount = 0;

    for (const finding of cappedFindings) {
      const id = `${finding.file}:${finding.line}:${finding.ruleId}`;
      const validation = validationMap.get(id);

      // Default to 0.7 confidence if LLM didn't validate this finding
      const confidence = validation?.confidence ?? 0.7;
      const likelyFalsePositive = confidence < confidenceThreshold;

      if (likelyFalsePositive) {
        filteredCount++;
      }

      validatedFindings.push({
        ruleId: finding.ruleId,
        file: finding.file,
        line: finding.line,
        severity: finding.severity,
        summary: finding.summary,
        confidence,
        reasoning: validation?.reasoning,
        likelyFalsePositive,
      });
    }

    // Add any findings that weren't capped (without validation)
    for (let i = MAX_FINDINGS_PER_CALL; i < findings.length; i++) {
      const finding = findings[i];
      validatedFindings.push({
        ruleId: finding.ruleId,
        file: finding.file,
        line: finding.line,
        severity: finding.severity,
        summary: finding.summary,
        confidence: 0.7, // Default confidence for uncapped findings
        reasoning: "Not validated due to batch limit",
        likelyFalsePositive: false,
      });
    }

    return {
      validatedFindings,
      filteredCount,
      tokensUsed,
    };
  } catch (error) {
    // vibecheck-ignore-next-line SILENT_ERROR - Intentional: LLM failure shouldn't block analysis
    console.error("[LLM] Finding validation failed:", error instanceof Error ? error.message : "unknown");
    return null;
  }
}
