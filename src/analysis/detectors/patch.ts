/**
 * Patch-based static analysis - line-by-line detection on diff patches.
 */

import {
  MAX_FINDINGS_PER_FILE,
  IO_PATTERNS,
  DEBUG_PATTERNS,
  REQUEST_INPUT_PATTERNS,
  LOOP_PATTERNS,
  DB_QUERY_PATTERNS,
  COLLECTION_PROCESSING_PATTERNS,
  FILE_WRITE_PATTERNS,
  RETRY_PATTERNS,
  TIGHT_LOOP_PATTERNS,
  CHECK_PATTERNS,
  MEMORY_RISK_PATTERNS,
  SECRET_PATTERNS,
  BLOCKING_PATTERNS,
  STATEFUL_SERVICE_PATTERNS,
  PROTOTYPE_INFRA_PATTERNS,
  UNSAFE_EVAL_PATTERNS,
  HARDCODED_URL_PATTERNS,
  matchesAnyPattern,
} from "../patterns";

import {
  parseHunkHeader,
  hasErrorHandlingNearby,
  hasValidationNearby,
  isInRouteHandlerContext,
  hasLoopNearby,
  isInAsyncContext,
  isSilentCatch,
  isTopLevelDeclaration,
  extractVariableName,
  isVariableMutatedLater,
  isTestFile,
  hasPaginationNearby,
  hasBatchingNearby,
  isInRequestContext,
  hasHardcodedFilePath,
  hasBackoffNearby,
  hasDelayInLoopBody,
  hasActPatternNearby,
  extractCallSignature,
  hasIOInLoopBody,
  collectResponseShapes,
  areShapesDifferent,
} from "../helpers";

import { Finding } from "./types";

/**
 * Analyze a single patch string from GitHub for a given file.
 * Returns an array of findings.
 */
export function analyzePatch(file: string, patch: string): Finding[] {
  const findings: Finding[] = [];

  // Defensive: return empty if patch is missing or empty
  if (!patch || patch.trim() === "") {
    return findings;
  }

  const lines = patch.split("\n");
  let currentLine = 0; // Line number in the target file

  // Track state for cross-line analysis
  const seenRequestInputLines: number[] = [];
  const topLevelMutableVars: { name: string; line: number; index: number }[] = [];

  // Track external call signatures for NO_CACHING detection
  const callSignatureCounts = new Map<string, { count: number; firstLine: number; snippet: string }>();

  // First pass: collect response shapes for MIXED_RESPONSE_SHAPES
  const responseShapes = collectResponseShapes(lines);
  if (responseShapes.length >= 2) {
    // Check if shapes are different
    for (let i = 0; i < responseShapes.length - 1; i++) {
      for (let j = i + 1; j < responseShapes.length; j++) {
        if (areShapesDifferent(responseShapes[i].shape, responseShapes[j].shape)) {
          findings.push({
            file,
            line: responseShapes[i].line,
            severity: "medium",
            kind: "MIXED_RESPONSE_SHAPES",
            message:
              "This code returns different response shapes from the same module/handler, which complicates clients and error handling.",
            snippet: `Shapes differ at lines ${responseShapes[i].line} and ${responseShapes[j].line}`,
          });
          break; // Only report once per file
        }
      }
      if (findings.some((f) => f.kind === "MIXED_RESPONSE_SHAPES")) break;
    }
  }

  // Main analysis pass
  for (let i = 0; i < lines.length; i++) {
    // Stop if we've hit the max findings for this file
    if (findings.length >= MAX_FINDINGS_PER_FILE) {
      break;
    }

    const line = lines[i];

    // Check for hunk header to update line tracking
    const hunkStart = parseHunkHeader(line);
    if (hunkStart !== null) {
      currentLine = hunkStart;
      continue;
    }

    // Skip diff metadata lines
    if (line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }

    // Only analyze added lines (starting with "+")
    if (line.startsWith("+")) {
      const content = line.slice(1); // Remove the leading "+"
      const trimmedContent = content.trim();

      // Skip empty lines
      if (trimmedContent === "") {
        currentLine++;
        continue;
      }

      // ========================================
      // a) TEMPORARY_HACK detection
      // ========================================
      if (/\b(TODO|FIXME|HACK|XXX|TEMP)\b/i.test(content)) {
        findings.push({
          file,
          line: currentLine,
          severity: "medium",
          kind: "TEMPORARY_HACK",
          message: "Temporary hack or unfinished code detected. This should be resolved before production.",
          snippet: trimmedContent.slice(0, 100),
        });
      }

      // ========================================
      // b) UNSAFE_IO detection
      // ========================================
      const hasIOPattern = matchesAnyPattern(content, IO_PATTERNS);
      if (hasIOPattern) {
        // Check if there's error handling nearby in the patch
        if (!hasErrorHandlingNearby(lines, i)) {
          // Check if this is inside a loop (which is a separate, higher severity issue)
          if (!hasLoopNearby(lines, i)) {
            findings.push({
              file,
              line: currentLine,
              severity: "high",
              kind: "UNSAFE_IO",
              message:
                "Network/database/filesystem call with no apparent error handling. This could cause production incidents.",
              snippet: trimmedContent.slice(0, 100),
            });
          }
        }
      }

      // ========================================
      // c) CONSOLE_DEBUG detection (only for non-test files)
      // ========================================
      if (!isTestFile(file)) {
        const hasDebugPattern = matchesAnyPattern(content, DEBUG_PATTERNS);
        if (hasDebugPattern) {
          findings.push({
            file,
            line: currentLine,
            severity: "low",
            kind: "CONSOLE_DEBUG",
            message:
              "Debug logging detected. Consider using structured logging or removing before production deployment.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // d) UNVALIDATED_INPUT detection
      // ========================================
      const hasRequestInput = matchesAnyPattern(content, REQUEST_INPUT_PATTERNS);
      if (hasRequestInput) {
        seenRequestInputLines.push(i);
        // Check if we're in a route handler context and no validation nearby
        if (isInRouteHandlerContext(lines, i) && !hasValidationNearby(lines, i)) {
          findings.push({
            file,
            line: currentLine,
            severity: "medium",
            kind: "UNVALIDATED_INPUT",
            message:
              "Request input appears to be used without explicit validation. Prototype-style input handling can cause runtime failures in production.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // e) DATA_SHAPE_ASSUMPTION detection
      // ========================================
      // Non-null assertion: !.
      if (/!\.\w/.test(content) || /\w!\./.test(content)) {
        findings.push({
          file,
          line: currentLine,
          severity: "medium",
          kind: "DATA_SHAPE_ASSUMPTION",
          message:
            "Non-null assertion detected. Code is making strong assumptions about data shape that may not hold in production.",
          snippet: trimmedContent.slice(0, 100),
        });
      }
      // Type assertion on external data: as SomeType (heuristic)
      if (/as\s+\w+/.test(content) && matchesAnyPattern(content, REQUEST_INPUT_PATTERNS)) {
        findings.push({
          file,
          line: currentLine,
          severity: "medium",
          kind: "DATA_SHAPE_ASSUMPTION",
          message:
            "Type assertion on request data detected. Consider using runtime validation instead of compile-time assertions.",
          snippet: trimmedContent.slice(0, 100),
        });
      }

      // ========================================
      // f) LOOPED_IO detection
      // ========================================
      if (hasIOPattern && hasLoopNearby(lines, i)) {
        findings.push({
          file,
          line: currentLine,
          severity: "high",
          kind: "LOOPED_IO",
          message:
            "Loop appears to perform network/DB/FS operations for each item. This can cause serious performance and reliability issues at scale.",
          snippet: trimmedContent.slice(0, 100),
        });
      }

      // ========================================
      // g) SILENT_ERROR detection
      // ========================================
      if (content.includes("catch") || content.includes(".catch(")) {
        if (isSilentCatch(lines, i)) {
          // Determine severity based on whether I/O is nearby
          const hasIONearby = IO_PATTERNS.some((pattern) => {
            for (let j = Math.max(0, i - 10); j < Math.min(lines.length, i + 10); j++) {
              const line = lines[j];
              if (line && (typeof pattern === "string" ? line.includes(pattern) : pattern.test(line))) return true;
            }
            return false;
          });

          findings.push({
            file,
            line: currentLine,
            severity: hasIONearby ? "high" : "medium",
            kind: "SILENT_ERROR",
            message:
              "Catch block appears to swallow errors silently. This hides failures and makes debugging production issues very difficult.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // h) GLOBAL_MUTATION detection
      // ========================================
      if (isTopLevelDeclaration(line)) {
        const varName = extractVariableName(line);
        if (varName) {
          // Check if it's a mutable declaration (let or var, or const with object/array)
          const isMutable = /^\+(?:let|var)\s/.test(line) || /^\+const\s+\w+\s*=\s*[\[{]/.test(line);
          if (isMutable) {
            topLevelMutableVars.push({ name: varName, line: currentLine, index: i });
          }
        }
      }

      // ========================================
      // i) ASYNC_MISUSE detection
      // ========================================
      if (isInAsyncContext(lines, i)) {
        // Check for .then() without .catch()
        if (content.includes(".then(") && !hasErrorHandlingNearby(lines, i)) {
          findings.push({
            file,
            line: currentLine,
            severity: "medium",
            kind: "ASYNC_MISUSE",
            message:
              "Promise chain with .then() but no visible .catch(). Async operations may ignore errors or lead to unhandled rejections.",
            snippet: trimmedContent.slice(0, 100),
          });
        }

        // Check for fire-and-forget async calls (async function called without await)
        const asyncCallPatterns = ["fetch(", "axios.", "client.query(", "prisma.", "mongoose."];
        const hasAsyncCall = asyncCallPatterns.some((p) => content.includes(p));
        if (hasAsyncCall && !content.includes("await") && !content.includes("return") && !content.includes(".then(")) {
          findings.push({
            file,
            line: currentLine,
            severity: "medium",
            kind: "ASYNC_MISUSE",
            message: "Async operation appears to be fire-and-forget (no await or .then()). Errors may be silently ignored.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // SCALING-FOCUSED RULES
      // ========================================

      // ========================================
      // j) UNBOUNDED_QUERY detection
      // ========================================
      const hasDbQueryPattern = matchesAnyPattern(content, DB_QUERY_PATTERNS);
      if (hasDbQueryPattern) {
        // Check if there's pagination/limit nearby
        if (!hasPaginationNearby(lines, i)) {
          findings.push({
            file,
            line: currentLine,
            severity: "high",
            kind: "UNBOUNDED_QUERY",
            message:
              "Database query appears unbounded (no LIMIT/pagination). This may work in dev but will break or slow down at higher data volumes.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // k) UNBOUNDED_COLLECTION_PROCESSING detection
      // ========================================
      const hasCollectionProcessing = matchesAnyPattern(content, COLLECTION_PROCESSING_PATTERNS);
      if (hasCollectionProcessing && isInRequestContext(lines, i)) {
        // Check if it looks like processing a potentially large collection
        const largeCollectionHint =
          /\b(items|rows|users|messages|data|results|records|entries|documents|events|logs|orders|products)\b/i.test(
            content
          );
        if (largeCollectionHint) {
          findings.push({
            file,
            line: currentLine,
            severity: "high",
            kind: "UNBOUNDED_COLLECTION_PROCESSING",
            message:
              "Request/handler code is processing a potentially unbounded collection. This may be fine with few items but will not scale as data or tenants grow.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // l) MISSING_BATCHING detection
      // ========================================
      // Detect loops that will have I/O without batching
      const isLoopStart = matchesAnyPattern(content, LOOP_PATTERNS);
      if (isLoopStart) {
        // Check if there's I/O in the loop body and no batching nearby
        if (hasIOInLoopBody(lines, i) && !hasBatchingNearby(lines, i)) {
          findings.push({
            file,
            line: currentLine,
            severity: "high",
            kind: "MISSING_BATCHING",
            message:
              "This loop performs external I/O per item with no batching. This pattern often vibe-crashes at scale due to latency and cost.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // m) NO_CACHING detection (track calls for post-processing)
      // ========================================
      const callSig = extractCallSignature(content);
      if (callSig) {
        const existing = callSignatureCounts.get(callSig);
        if (existing) {
          existing.count++;
        } else {
          callSignatureCounts.set(callSig, { count: 1, firstLine: currentLine, snippet: trimmedContent.slice(0, 100) });
        }
      }

      // ========================================
      // n) MEMORY_RISK detection
      // ========================================
      const hasMemoryRiskPattern = matchesAnyPattern(content, MEMORY_RISK_PATTERNS);
      if (hasMemoryRiskPattern) {
        // Check for signs of streaming (which would mitigate the risk)
        const hasStreamingHint = /stream|pipe|chunk|createReadStream/i.test(content);
        if (!hasStreamingHint) {
          findings.push({
            file,
            line: currentLine,
            severity: "high",
            kind: "MEMORY_RISK",
            message:
              "Code loads entire files or datasets into memory. This is a common source of memory exhaustion and crash at scale.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // CONCURRENCY/CONTENTION RULES
      // ========================================

      // ========================================
      // o) SHARED_FILE_WRITE detection
      // ========================================
      const hasFileWritePattern = matchesAnyPattern(content, FILE_WRITE_PATTERNS);
      if (hasFileWritePattern && hasHardcodedFilePath(content)) {
        findings.push({
          file,
          line: currentLine,
          severity: "high",
          kind: "SHARED_FILE_WRITE",
          message:
            "Writing to a hardcoded file path. Multiple concurrent requests/workers may cause data corruption or race conditions.",
          snippet: trimmedContent.slice(0, 100),
        });
      }

      // ========================================
      // p) RETRY_STORM_RISK detection
      // ========================================
      const hasRetryPattern = matchesAnyPattern(content.toLowerCase(), RETRY_PATTERNS);
      if (hasRetryPattern && hasIOPattern) {
        // Check if there's backoff/jitter nearby
        if (!hasBackoffNearby(lines, i)) {
          findings.push({
            file,
            line: currentLine,
            severity: "high",
            kind: "RETRY_STORM_RISK",
            message:
              "Retry logic with external calls but no exponential backoff or jitter. This can cause thundering herd problems and DoS your dependencies.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // q) BUSY_WAIT_OR_TIGHT_LOOP detection
      // ========================================
      const hasTightLoopPattern = matchesAnyPattern(content, TIGHT_LOOP_PATTERNS);
      if (hasTightLoopPattern) {
        // Check if there's a delay inside the loop body
        if (!hasDelayInLoopBody(lines, i)) {
          findings.push({
            file,
            line: currentLine,
            severity: "high",
            kind: "BUSY_WAIT_OR_TIGHT_LOOP",
            message: "Tight loop without delay/sleep detected. This can peg CPU at 100% and starve other processes.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // r) CHECK_THEN_ACT_RACE detection
      // ========================================
      const hasCheckPattern = matchesAnyPattern(content, CHECK_PATTERNS);
      if (hasCheckPattern) {
        // Look for a create/insert pattern following this check
        if (hasActPatternNearby(lines, i)) {
          findings.push({
            file,
            line: currentLine,
            severity: "medium",
            kind: "CHECK_THEN_ACT_RACE",
            message:
              "Find-then-create pattern detected. This can race under concurrent requests, causing duplicate inserts or errors. Consider upsert or database-level constraints.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // s) HARDCODED_SECRET detection
      // ========================================
      const hasSecretPattern = matchesAnyPattern(content, SECRET_PATTERNS);
      if (hasSecretPattern) {
        findings.push({
          file,
          line: currentLine,
          severity: "high",
          kind: "HARDCODED_SECRET",
          message:
            "Hardcoded secret or credential detected. Secrets should be stored in environment variables or a secrets manager, never in source code.",
          snippet: trimmedContent.slice(0, 100),
        });
      }

      // ========================================
      // t) BLOCKING_OPERATION detection (skip test files)
      // ========================================
      if (!isTestFile(file)) {
        const hasBlockingPattern = matchesAnyPattern(content, BLOCKING_PATTERNS);
        if (hasBlockingPattern) {
          findings.push({
            file,
            line: currentLine,
            severity: "medium",
            kind: "BLOCKING_OPERATION",
            message:
              "Synchronous blocking operation detected. This blocks the event loop and can cause performance issues under load. Consider using async alternatives.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // u) STATEFUL_SERVICE detection
      // ========================================
      const hasStatefulServicePattern = matchesAnyPattern(content, STATEFUL_SERVICE_PATTERNS);
      if (hasStatefulServicePattern) {
        findings.push({
          file,
          line: currentLine,
          severity: "high",
          kind: "STATEFUL_SERVICE",
          message:
            "In-memory state storage detected. This prevents horizontal scaling - each instance has separate state. Use Redis, database, or external cache instead.",
          snippet: trimmedContent.slice(0, 100),
        });
      }

      // ========================================
      // v) PROTOTYPE_INFRA detection
      // ========================================
      const hasPrototypeInfraPattern = matchesAnyPattern(content, PROTOTYPE_INFRA_PATTERNS);
      if (hasPrototypeInfraPattern) {
        findings.push({
          file,
          line: currentLine,
          severity: "high",
          kind: "PROTOTYPE_INFRA",
          message:
            "Prototype-grade infrastructure detected (SQLite, file-based storage, embedded DB). This won't work in cloud/container deployments with multiple instances.",
          snippet: trimmedContent.slice(0, 100),
        });
      }

      // ========================================
      // w) UNSAFE_EVAL detection
      // ========================================
      const hasUnsafeEvalPattern = matchesAnyPattern(content, UNSAFE_EVAL_PATTERNS);
      if (hasUnsafeEvalPattern) {
        findings.push({
          file,
          line: currentLine,
          severity: "high",
          kind: "UNSAFE_EVAL",
          message:
            "Unsafe code execution detected (eval, exec, new Function). This is a security vulnerability that allows arbitrary code execution.",
          snippet: trimmedContent.slice(0, 100),
        });
      }

      // ========================================
      // x) HARDCODED_URL detection (skip test files)
      // ========================================
      if (!isTestFile(file)) {
        const hasHardcodedUrlPattern = matchesAnyPattern(content, HARDCODED_URL_PATTERNS);
        if (hasHardcodedUrlPattern) {
          findings.push({
            file,
            line: currentLine,
            severity: "medium",
            kind: "HARDCODED_URL",
            message:
              "Hardcoded URL detected (localhost, IP address, or full URL). Use environment variables or configuration for deployment flexibility.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      currentLine++;
    } else if (line.startsWith("-")) {
      // Removed line - don't increment line counter
      continue;
    } else {
      // Context line (no prefix) - increment line counter
      currentLine++;
    }
  }

  // Post-pass: Check for GLOBAL_MUTATION
  for (const mutableVar of topLevelMutableVars) {
    if (isVariableMutatedLater(lines, mutableVar.name, mutableVar.index)) {
      findings.push({
        file,
        line: mutableVar.line,
        severity: "high",
        kind: "GLOBAL_MUTATION",
        message:
          "Top-level mutable state detected and mutated. In a server environment this can cause cross-request and concurrency bugs.",
        snippet: `Variable '${mutableVar.name}' is mutated after declaration`,
      });
    }
  }

  // Post-pass: Check for NO_CACHING (repeated identical calls)
  for (const [signature, data] of callSignatureCounts.entries()) {
    if (data.count >= 2 && findings.length < MAX_FINDINGS_PER_FILE) {
      // Determine severity: external API calls are higher severity
      const isExternalApi = signature.includes("http") || signature.includes("api.") || signature.includes("fetch(");
      findings.push({
        file,
        line: data.firstLine,
        severity: isExternalApi ? "high" : "medium",
        kind: "NO_CACHING",
        message: `Repeated identical expensive calls detected (${data.count}x). Consider caching or deduplication to avoid cost and latency blowups at scale.`,
        snippet: data.snippet,
      });
    }
  }

  return findings;
}
