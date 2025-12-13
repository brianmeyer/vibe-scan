/**
 * LLM-based validation of static findings with confidence scoring.
 * Uses tiered models: fast model for simple rules, reasoning model for complex rules.
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
  StaticFindingSummary,
  MAX_FINDINGS_PER_CALL,
  MODEL_FAST,
  MODEL_REASONING,
  COMPLEX_RULES,
} from "./types";

/**
 * Classify a finding as simple or complex based on rule type.
 */
function isComplexFinding(finding: StaticFindingSummary): boolean {
  return COMPLEX_RULES.has(finding.ruleId);
}

/**
 * Parse LLM validation response into a map of results.
 */
function parseValidationResponse(
  content: string
): Map<string, { confidence: number; reasoning?: string }> | null {
  let parsed: unknown;
  try {
    let jsonStr = content;

    // Extract from markdown code block
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    } else {
      // Find JSON array pattern
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }
    }

    parsed = JSON.parse(jsonStr);
  } catch (parseError) {
    console.error("[LLM] Failed to parse validation response:", parseError instanceof Error ? parseError.message : "unknown");
    const truncated = content.length > 500 ? content.slice(0, 500) + "...[truncated]" : content;
    console.error("[LLM] Raw response:", truncated);
    return null;
  }

  if (!Array.isArray(parsed)) {
    console.warn("[LLM] Invalid validation response structure - expected array, got:", typeof parsed);
    return null;
  }

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

  return validationMap;
}

/**
 * Validate a batch of findings with a specific model.
 */
async function validateBatch(
  client: OpenAI,
  findings: StaticFindingSummary[],
  codeContext: Map<string, string>,
  model: string,
  installationId?: number
): Promise<{ validationMap: Map<string, { confidence: number; reasoning?: string }>; tokensUsed: number } | null> {
  if (findings.length === 0) {
    return { validationMap: new Map(), tokensUsed: 0 };
  }

  const prompt = buildValidationPrompt(findings, codeContext);

  const completion = await withRetry(() =>
    client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 2048,
    })
  );

  const tokensUsed = completion.usage?.total_tokens || 0;

  if (installationId) {
    await recordTokenUsage(installationId, tokensUsed);
  }

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    console.warn(`[LLM] Empty validation response from ${model}`);
    return null;
  }

  const validationMap = parseValidationResponse(content);
  if (!validationMap) {
    return null;
  }

  return { validationMap, tokensUsed };
}

/**
 * Validate static findings with LLM to filter false positives and assign confidence scores.
 *
 * Uses a tiered approach:
 * - Simple rules (TEMPORARY_HACK, etc.) use fast 8B model
 * - Complex rules (UNBOUNDED_QUERY, SILENT_ERROR, etc.) use 120B reasoning model
 *
 * This optimizes cost while ensuring complex patterns get proper analysis.
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

  // Cap findings to avoid token explosion
  const cappedFindings = findings.slice(0, MAX_FINDINGS_PER_CALL);

  if (findings.length > MAX_FINDINGS_PER_CALL) {
    console.warn(`[LLM] Capping validation to ${MAX_FINDINGS_PER_CALL} findings (${findings.length} total)`);
  }

  // Split findings into simple and complex
  const simpleFindings = cappedFindings.filter(f => !isComplexFinding(f));
  const complexFindings = cappedFindings.filter(f => isComplexFinding(f));

  console.log(`[LLM] Tiered validation: ${simpleFindings.length} simple (${MODEL_FAST}), ${complexFindings.length} complex (${MODEL_REASONING})`);

  try {
    const client = new OpenAI({
      apiKey: config.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });

    // Validate both tiers in parallel
    const [simpleResult, complexResult] = await Promise.all([
      simpleFindings.length > 0
        ? validateBatch(client, simpleFindings, codeContext, MODEL_FAST, installationId)
        : Promise.resolve({ validationMap: new Map(), tokensUsed: 0 }),
      complexFindings.length > 0
        ? validateBatch(client, complexFindings, codeContext, MODEL_REASONING, installationId)
        : Promise.resolve({ validationMap: new Map(), tokensUsed: 0 }),
    ]);

    // Merge validation maps
    const validationMap = new Map<string, { confidence: number; reasoning?: string }>();

    if (simpleResult) {
      for (const [id, result] of simpleResult.validationMap) {
        validationMap.set(id, result);
      }
    }

    if (complexResult) {
      for (const [id, result] of complexResult.validationMap) {
        validationMap.set(id, result);
      }
    }

    const tokensUsed = (simpleResult?.tokensUsed || 0) + (complexResult?.tokensUsed || 0);

    console.log(`[LLM] Successfully validated ${validationMap.size}/${cappedFindings.length} findings, ${tokensUsed} tokens total`);

    // Map findings to validated findings
    const validatedFindings: ValidatedFinding[] = [];
    let filteredCount = 0;

    for (const finding of cappedFindings) {
      const id = `${finding.file}:${finding.line}:${finding.ruleId}`;
      const validation = validationMap.get(id);

      // Default confidence based on complexity - complex rules get lower default (more skeptical)
      const defaultConfidence = isComplexFinding(finding) ? 0.5 : 0.7;
      const confidence = validation?.confidence ?? defaultConfidence;
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
        confidence: 0.7,
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
    // vibescan-ignore-next-line SILENT_ERROR - Intentional: LLM failure shouldn't block analysis
    console.error("[LLM] Finding validation failed:", error instanceof Error ? error.message : "unknown");
    return null;
  }
}
