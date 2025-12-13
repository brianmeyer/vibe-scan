/**
 * LLM prompt builders for various analysis tasks.
 */

import { StaticFindingSummary, ExecutiveSummaryInput } from "./types";

/**
 * Build the prompt for production risk analysis.
 */
export function buildVibePrompt(params: {
  file: string;
  language?: string;
  snippet: string;
  diffContext?: string;
  staticFindings?: StaticFindingSummary[];
  fileStructure?: string;
  fullContent?: string;
}): string {
  const { file, language, snippet, diffContext, staticFindings, fileStructure, fullContent } = params;

  const languageHint = language ? ` (${language})` : "";
  const diffSection = diffContext
    ? `\n\nDiff context (surrounding changes):\n\`\`\`\n${diffContext}\n\`\`\``
    : "";

  // Build static findings section if provided
  let staticFindingsSection = "";
  if (staticFindings && staticFindings.length > 0) {
    // Cap at 50 findings to avoid token explosion
    const cappedFindings = staticFindings.slice(0, 50);
    const staticFindingsJson = JSON.stringify(cappedFindings, null, 2);
    staticFindingsSection = `
Here is a compact JSON summary of static analysis findings that were already detected:

\`\`\`json
${staticFindingsJson}
\`\`\`

Use these as primary evidence of potential problems. Cluster related findings into higher-level issues rather than re-listing each one individually. Connect issues to environment assumptions, observability gaps, and resilience gaps where relevant.

`;
  }

  // Build file structure context section if provided
  let fileStructureSection = "";
  if (fileStructure) {
    fileStructureSection = `
### File Dependency & Structure Context

Use this structural summary to understand the file's dependencies, exports, and overall organization. This helps identify potential issues with external dependencies, missing error handling for imports, and architectural concerns.

${fileStructure}

`;
  }

  // Build full content section if provided
  let codeSection = "";
  if (fullContent) {
    codeSection = `
### Full File Context

Use this complete file content to verify deep logical issues like race conditions, unhandled errors across function boundaries, and cross-cutting concerns. The snippet below shows only the changed lines.

Full file content:
\`\`\`
${fullContent}
\`\`\`

Changed lines (snippet):
\`\`\`
${snippet}
\`\`\`${diffSection}`;
  } else {
    codeSection = `
Code snippet:
\`\`\`
${snippet}
\`\`\`${diffSection}`;
  }

  return `You are a senior production engineer analyzing backend code for production risks in a startup environment.
${fileStructureSection}${staticFindingsSection}
Your task is to identify issues and classify them into the following production risk categories:

**SCALING_RISK**: Problems that will cause performance or cost issues as traffic grows.
- Unbounded queries (SELECT *, findMany without limits)
- N+1 query patterns
- Per-item remote calls in loops
- Loading entire datasets into memory
- Missing pagination or batching

**CONCURRENCY_RISK**: Race conditions and contention issues.
- Shared mutable state across requests
- Non-atomic check-then-act patterns (find-then-create races)
- Retry storms without exponential backoff
- Unsafe parallel mutations
- File writes to shared paths

**ENVIRONMENT_ASSUMPTION**: Hidden assumptions about infrastructure/dependencies.
- Assuming APIs are always available or fast
- Hardcoded timeouts that are too short/long
- No handling for rate limits or throttling
- Single-region or single-instance assumptions
- Missing graceful degradation

**DATA_CONTRACT_RISK**: Assumptions about data shapes and validation.
- Missing input validation (request bodies, query params)
- Non-null assertions on external data
- Type assertions without runtime checks
- Inconsistent response shapes
- Missing idempotency in event handlers

**OBSERVABILITY_GAP**: Missing instrumentation for production debugging.
- No structured logging in critical paths
- Silent failures (empty catch blocks)
- Missing metrics or tracing
- console.log instead of proper logging
- Errors that would be hard to debug in production

**RESILIENCE_GAP**: Missing fault tolerance around fragile operations.
- External calls without timeouts
- No retry logic for transient failures
- Missing circuit breakers
- No dead-letter queues for failed jobs
- No fallbacks for degraded dependencies

Analyze this code from file: ${file}${languageHint}
${codeSection}

Respond ONLY with a JSON object matching this exact TypeScript interface (no markdown, no extra text):

{
  "issues": [
    {
      "kind": "SCALING_RISK" | "CONCURRENCY_RISK" | "ENVIRONMENT_ASSUMPTION" | "DATA_CONTRACT_RISK" | "OBSERVABILITY_GAP" | "RESILIENCE_GAP",
      "title": "short title (max 10 words)",
      "file": "optional file path",
      "line": optional line number,
      "summary": "1-2 sentence explanation",
      "evidenceSnippet": "optional code snippet showing the issue",
      "suggestedFix": "optional 1-2 sentence fix suggestion",
      "severity": "low" | "medium" | "high"
    }
  ],
  "architectureSummary": "optional 2-4 sentence summary of the highest-risk patterns"
}

Severity guidelines:
- "low": Minor concern, nice to fix but not urgent
- "medium": Should fix before production, could cause issues under load
- "high": Critical, must fix before production, will cause failures

Rules:
- If there are no meaningful issues, return { "issues": [], "architectureSummary": null }
- Focus on grouping and explaining the most important issues based on the static findings
- Do not re-list every finding individually; cluster related findings into a smaller number of higher-level issues
- When possible, connect issues to environment assumptions, observability gaps, and resilience gaps
- Keep explanations and fixes concise (max 2 sentences each)
- Do NOT include any text outside the JSON object
- Prioritize scaling issues that grow with data size or tenant count`;
}

/**
 * Build a prompt for generating an executive summary.
 */
export function buildExecutiveSummaryPrompt(input: ExecutiveSummaryInput): string {
  const findingsList = Array.from(input.findingsByKind.entries())
    .map(([kind, data]) => `- ${kind}: ${data.count} finding(s), severity=${data.severity}, files: ${data.files.slice(0, 3).join(", ")}${data.files.length > 3 ? ` (+${data.files.length - 3} more)` : ""}`)
    .join("\n");

  return `You are a senior software engineer reviewing a pull request for production readiness.

Based on the following static analysis findings, write a concise 2-3 sentence executive summary that:
1. Highlights the most critical issues that need immediate attention
2. Groups related problems (e.g., "multiple network calls lack error handling")
3. Suggests the highest-priority fix

FINDINGS SUMMARY:
Total: ${input.totalFindings} findings (${input.highCount} high, ${input.mediumCount} medium)
Vibe Score: ${input.vibeScore}/100

BY CATEGORY:
${findingsList}

RULES:
- Be concise and actionable (2-3 sentences max)
- Focus on production risk, not code style
- Use specific numbers ("7 fetch calls" not "several calls")
- If score is 0-30, emphasize critical blockers
- If score is 31-70, note areas needing attention
- If score is 71-100, acknowledge good state with minor suggestions

Respond with ONLY the summary text, no JSON or formatting.`;
}

/**
 * Build a prompt for validating static findings.
 */
export function buildValidationPrompt(
  findings: StaticFindingSummary[],
  codeContext: Map<string, string>
): string {
  // Group findings by file for context
  const findingsByFile = new Map<string, StaticFindingSummary[]>();
  for (const finding of findings) {
    const existing = findingsByFile.get(finding.file) || [];
    existing.push(finding);
    findingsByFile.set(finding.file, existing);
  }

  // Build code context sections
  const codeContextSections: string[] = [];
  for (const [file, code] of codeContext.entries()) {
    const fileFindings = findingsByFile.get(file) || [];
    if (fileFindings.length > 0) {
      codeContextSections.push(`### ${file}
\`\`\`
${code.slice(0, 3000)}${code.length > 3000 ? "\n... (truncated)" : ""}
\`\`\`

Findings in this file:
${fileFindings.map(f => `- Line ${f.line}: ${f.ruleId} - ${f.summary}`).join("\n")}`);
    }
  }

  const findingsJson = JSON.stringify(
    findings.map(f => ({
      id: `${f.file}:${f.line}:${f.ruleId}`,
      ruleId: f.ruleId,
      file: f.file,
      line: f.line,
      severity: f.severity,
      summary: f.summary,
    })),
    null,
    2
  );

  return `You are a senior production engineer validating static analysis findings for accuracy.

Your task is to review each finding and assign a confidence score (0.0 to 1.0) indicating how likely it is to be a TRUE POSITIVE (real production risk).

CRITICAL CONTEXT - VIBE-CODED PATTERNS:
This tool detects "vibe-coded" patterns - AI-generated or hastily-written code that "looks correct" but lacks architectural judgment. Studies show:
- 40% of AI-generated code contains security vulnerabilities
- 73% of AI-built startups hit scaling failures within 6 months
- Common failure modes: code works in development but fails with multiple instances, growing data, or unreliable dependencies

BE SKEPTICAL OF CODE THAT:
- Looks syntactically correct but makes hidden assumptions about infrastructure
- Works for single-user/single-instance but won't scale horizontally
- Has no defense against external service failures
- Assumes data sizes will stay small forever
- Lacks architectural patterns (retries, circuit breakers, batching) that production systems need

IMPORTANT SCORING GUIDELINES:
- 0.9-1.0: Definite true positive - clear production risk with strong evidence
- 0.7-0.89: Likely true positive - probable risk, may need context
- 0.5-0.69: Uncertain - could go either way, needs human review
- 0.3-0.49: Likely false positive - pattern match but probably safe in context
- 0.0-0.29: Definite false positive - clear safe usage, not a real risk

VIBE-CODED PATTERNS THAT ARE TRUE POSITIVES (DO flag these):
- Database queries without LIMIT that will grow with user data
- Loops over user-generated data (comments, files, items) without bounds
- External API calls without timeout, retry, or error handling
- In-memory caches or state that will break with multiple server instances
- Hard-coded URLs, credentials, or configuration that blocks deployment
- "Happy path only" code that assumes external services never fail
- Pagination that loads all items then slices (memory bomb waiting to happen)
- Webhook/event handlers that don't deduplicate or handle retries
- Check-then-act patterns without locking (will race under load)
- Missing input validation on user-provided data sizes or counts

COMMON FALSE POSITIVE PATTERNS TO WATCH FOR:
- Array.filter(), Array.map(), Array.find() flagged as database queries (UNBOUNDED_QUERY)
- Intentional empty catch blocks that log errors then continue (SILENT_ERROR) - check if console.error/warn comes before the catch
- Try-catch with fallback behavior (returning null, default values) is NOT silent error handling
- Test/mock code flagged for production risks
- TypeScript type narrowing misidentified as unsafe
- Environment-specific code with proper guards
- Prototype/development files in expected locations
- Sequential API calls for rate limiting compliance (LOOPED_IO) - if code intentionally processes one at a time
- Small known-bounded loops (2-3 iterations max) flagged as MISSING_BATCHING or LOOPED_IO
- Webhook handlers that log errors then return gracefully (intentional error isolation)

ARCHITECTURE-SPECIFIC VALIDATION (be especially careful):
- STATEFUL_SERVICE: Only flag if actual shared mutable state across requests
- PROTOTYPE_INFRA: Only flag if truly temporary/experimental patterns
- UNBOUNDED_QUERY: Must be actual database/API calls, not array operations (Array.filter/map/find are NOT database queries)
- GLOBAL_MUTATION: Check if mutation is initialization vs. runtime modification
- LOOPED_IO: Check if sequential processing is intentional (e.g., respecting rate limits, retry backoff). Also check loop bounds - if iterating over a small fixed set (2-5 items), this is NOT a scaling risk
- MISSING_BATCHING: Only flag if the loop could realistically grow unbounded. Loops over fixed config or small known sets are fine
- SILENT_ERROR: Check if error is logged before being swallowed. Returning null/fallback after logging is INTENTIONAL error handling, not silent failure. Optional features that fail gracefully are fine

${codeContextSections.length > 0 ? `CODE CONTEXT:\n${codeContextSections.join("\n\n")}` : ""}

FINDINGS TO VALIDATE:
\`\`\`json
${findingsJson}
\`\`\`

OUTPUT FORMAT:
You MUST respond with ONLY a valid JSON array. No explanations, no markdown, no code blocks - just the raw JSON array.

Example output:
[{"id":"src/file.ts:10:RULE_ID","confidence":0.8,"reasoning":"Real risk because..."},{"id":"src/other.ts:20:RULE_ID","confidence":0.2,"reasoning":"False positive because..."}]

Your response (just the JSON array, nothing else):

RULES:
- Output ONLY the JSON array - no text before or after
- Validate EVERY finding in the input list
- Balance: Dismiss clear false positives (Array methods != DB queries) but FLAG real architectural risks
- Ask yourself: "Will this code fail when there are 10,000 users? 100 server instances? When the database has 1M rows?"
- Ask yourself: "What happens when the external API is slow, down, or rate-limited?"
- Code that "works in dev" is not evidence of production safety - look for defensive patterns
- Consider the code context when available`;
}
