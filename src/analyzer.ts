/**
 * Static analyzer for detecting "vibe-coded" or AI-generated prototype code
 * that may be risky for production (technical debt, scaling, reliability issues).
 *
 * This is a heuristic-based analyzer - no AST parsing or LLM involved.
 *
 * Rule Kinds:
 * - TEMPORARY_HACK: TODO/FIXME/HACK/XXX/TEMP comments
 * - UNSAFE_IO: I/O calls with no visible error handling
 * - CONSOLE_DEBUG: console.log/error/warn in non-test code
 * - UNVALIDATED_INPUT: request/handler code using req.* without validation
 * - DATA_SHAPE_ASSUMPTION: non-null assertions, unchecked property access
 * - LOOPED_IO: network/DB/FS calls inside loops
 * - SILENT_ERROR: catches or .catch that swallow errors
 * - GLOBAL_MUTATION: top-level mutable state likely shared across requests
 * - ASYNC_MISUSE: obvious async/await misuse (missing await, fire-and-forget)
 * - MIXED_RESPONSE_SHAPES: inconsistent response shapes in the same handler/module
 *
 * Scaling-focused Rule Kinds:
 * - UNBOUNDED_QUERY: DB or data queries with no limit/pagination
 * - UNBOUNDED_COLLECTION_PROCESSING: processing large/unbounded collections in request path
 * - MISSING_BATCHING: many items processed one-by-one instead of batched
 * - NO_CACHING: repeated identical expensive calls
 * - MEMORY_RISK: loading entire datasets/large blobs into memory
 *
 * Concurrency/Contention Rule Kinds:
 * - SHARED_FILE_WRITE: writing to a hardcoded file path (concurrency hazard)
 * - RETRY_STORM_RISK: retry loops without exponential backoff/jitter
 * - BUSY_WAIT_OR_TIGHT_LOOP: tight loops without delay (CPU spinning)
 * - CHECK_THEN_ACT_RACE: find-then-create patterns that can race
 */

import { RuleId, RuleLevel, isValidRuleId } from "./core/rules";
import { LoadedConfig, createDefaultConfig } from "./config/loadConfig";
import {
  parseSuppressionDirectives,
  isSuppressed,
  SuppressionDirective,
} from "./core/suppression";

export type Severity = "low" | "medium" | "high";

export interface Finding {
  file: string;
  line?: number;
  severity: Severity;
  kind: string;
  message: string;
  snippet?: string;
  /** The effective rule level from config (error/warning/info). */
  level?: RuleLevel;
  /** Whether this file is in a prototype zone. */
  isPrototypeZone?: boolean;
}

// Maximum findings per file to avoid overwhelming output
const MAX_FINDINGS_PER_FILE = 50;

// Code file extensions we care about
const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rb", ".java", ".cs"];

// Patterns for I/O operations that should have error handling
const IO_PATTERNS = [
  "fetch(",
  "axios.",
  "request(",
  "fs.",
  "client.query(",
  "db.",
  "execute(",
  "prisma.",
  "mongoose.",
  "redis.",
  "http.",
  "https.",
  "net.",
  "dgram.",
];

// Patterns that indicate error handling is present
const ERROR_HANDLING_PATTERNS = ["try", "catch", ".catch("];

// Debug logging patterns
const DEBUG_PATTERNS = ["console.log", "console.error", "console.warn", "console.debug", "print("];

// Validation library patterns
const VALIDATION_PATTERNS = [
  "zod",
  "yup",
  "Joi",
  "joi",
  "schema",
  "validate",
  "class-validator",
  "io-ts",
  "ajv",
  "validator",
  "sanitize",
  "parse",
  "safeParse",
];

// Request input patterns
const REQUEST_INPUT_PATTERNS = ["req.body", "req.query", "req.params", "request.body", "request.query", "request.params"];

// Route handler patterns
const ROUTE_HANDLER_PATTERNS = [
  "app.get(",
  "app.post(",
  "app.put(",
  "app.patch(",
  "app.delete(",
  "router.get(",
  "router.post(",
  "router.put(",
  "router.patch(",
  "router.delete(",
  "express.Router",
];

// Loop patterns
const LOOP_PATTERNS = ["for (", "for(", "for await (", "for await(", "while (", "while(", ".forEach(", ".map(", ".reduce("];

// Async patterns
const ASYNC_PATTERNS = ["async function", "async (", "async("];

// ============================================================================
// Scaling-focused pattern constants
// ============================================================================

// Database/ORM query patterns that may be unbounded
const DB_QUERY_PATTERNS = [
  "SELECT *",
  "SELECT * FROM",
  ".findMany(",
  ".find(",
  ".findAll(",
  "Model.find(",
  "Model.findAll(",
  ".aggregate(",
  ".query(",
  "prisma.",
  "db.select(",
  "db.query(",
  ".collection(",
  ".getAll(",
];

// Pagination/limit indicators that suggest bounded queries
const PAGINATION_PATTERNS = [
  ".limit(",
  ".take(",
  ".skip(",
  ".offset(",
  ".page(",
  ".perPage(",
  "LIMIT",
  "OFFSET",
  "TOP ",
  "FETCH FIRST",
  "pageSize",
  "pagination",
  ".slice(",
  ".paginate(",
];

// Collection processing patterns
const COLLECTION_PROCESSING_PATTERNS = [
  ".map(",
  ".filter(",
  ".reduce(",
  ".forEach(",
  "for (",
  "for(",
  "for of",
  "for await",
];

// Batching indicators
const BATCHING_PATTERNS = [
  "Promise.all(",
  "Promise.allSettled(",
  "chunk",
  "batch",
  "pageSize",
  "batchSize",
  "bulkWrite",
  "bulkInsert",
  "insertMany",
  "createMany",
  "$transaction",
];

// Memory-risky patterns (loading entire files/datasets into memory)
const MEMORY_RISK_PATTERNS = [
  "fs.readFileSync(",
  "readFileSync(",
  ".readFile(",
  "JSON.parse(fs.",
  "JSON.parse(readFileSync",
  ".toString()",
  "Buffer.from(",
  ".getObject(",
  ".download(",
  "toArray()",
  ".toArray()",
];

// External API call patterns for caching detection
const EXTERNAL_CALL_PATTERNS = [
  "fetch(",
  "axios.get(",
  "axios.post(",
  "axios(",
  "http.get(",
  "https.get(",
  "request(",
  "got(",
  "superagent",
];

// ============================================================================
// Concurrency/Contention pattern constants
// ============================================================================

// File write patterns (for SHARED_FILE_WRITE detection)
const FILE_WRITE_PATTERNS = [
  "fs.writeFile(",
  "fs.writeFileSync(",
  "fs.appendFile(",
  "fs.appendFileSync(",
  "writeFile(",
  "writeFileSync(",
  "appendFile(",
  "appendFileSync(",
];

// Retry-related patterns
const RETRY_PATTERNS = [
  "retry",
  "retries",
  "maxRetries",
  "numRetries",
  "attempt",
  "attempts",
];

// Backoff/jitter patterns that mitigate retry storms
const BACKOFF_PATTERNS = [
  "backoff",
  "exponential",
  "jitter",
  "delay *",
  "setTimeout",
  "sleep(",
  "wait(",
];

// Tight loop patterns (for BUSY_WAIT_OR_TIGHT_LOOP detection)
const TIGHT_LOOP_PATTERNS = [
  "while (true)",
  "while(true)",
  "for (;;)",
  "for(;;)",
  "while (1)",
  "while(1)",
];

// Check-then-act patterns (find/get followed by create/insert)
const CHECK_PATTERNS = [
  ".findOne(",
  ".findUnique(",
  ".findFirst(",
  ".get(",
  ".getOne(",
  "SELECT.*WHERE",
  ".exists(",
];

const ACT_PATTERNS = [
  ".create(",
  ".insert(",
  ".insertOne(",
  "INSERT INTO",
  ".save(",
  ".add(",
];

/**
 * Parse the starting line number from a unified diff hunk header.
 * Format: @@ -a,b +c,d @@ or @@ -a +c @@
 * Returns the starting line number for added lines (c).
 */
function parseHunkHeader(line: string): number | null {
  const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Check if a line (within the patch context) suggests error handling nearby.
 * We look at a window of lines around the current position.
 */
function hasErrorHandlingNearby(patchLines: string[], currentIndex: number, windowSize: number = 5): boolean {
  const start = Math.max(0, currentIndex - windowSize);
  const end = Math.min(patchLines.length, currentIndex + windowSize + 1);

  for (let i = start; i < end; i++) {
    const line = patchLines[i];
    if (line && ERROR_HANDLING_PATTERNS.some((pattern) => line.includes(pattern))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if validation patterns exist nearby in the patch.
 */
function hasValidationNearby(patchLines: string[], currentIndex: number, windowSize: number = 8): boolean {
  const start = Math.max(0, currentIndex - windowSize);
  const end = Math.min(patchLines.length, currentIndex + windowSize + 1);

  for (let i = start; i < end; i++) {
    const line = patchLines[i];
    if (line && VALIDATION_PATTERNS.some((pattern) => line.toLowerCase().includes(pattern.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if we're in a route handler context nearby.
 */
function isInRouteHandlerContext(patchLines: string[], currentIndex: number, windowSize: number = 15): boolean {
  const start = Math.max(0, currentIndex - windowSize);

  for (let i = start; i < currentIndex; i++) {
    const line = patchLines[i];
    if (line && ROUTE_HANDLER_PATTERNS.some((pattern) => line.includes(pattern))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if there's a loop nearby (before current line).
 */
function hasLoopNearby(patchLines: string[], currentIndex: number, windowSize: number = 8): boolean {
  const start = Math.max(0, currentIndex - windowSize);

  for (let i = start; i < currentIndex; i++) {
    const line = patchLines[i];
    if (line && LOOP_PATTERNS.some((pattern) => line.includes(pattern))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if we're in an async function context.
 */
function isInAsyncContext(patchLines: string[], currentIndex: number, windowSize: number = 20): boolean {
  const start = Math.max(0, currentIndex - windowSize);

  for (let i = start; i < currentIndex; i++) {
    const line = patchLines[i];
    if (line && ASYNC_PATTERNS.some((pattern) => line.includes(pattern))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a catch block appears to be empty or silent.
 */
function isSilentCatch(patchLines: string[], catchIndex: number): boolean {
  // Look for the opening brace after catch
  let braceDepth = 0;
  let foundOpenBrace = false;
  let contentLines: string[] = [];

  for (let i = catchIndex; i < Math.min(patchLines.length, catchIndex + 10); i++) {
    const line = patchLines[i] || "";

    if (line.includes("{")) {
      foundOpenBrace = true;
      braceDepth += (line.match(/{/g) || []).length;
    }
    if (line.includes("}")) {
      braceDepth -= (line.match(/}/g) || []).length;
    }

    if (foundOpenBrace && i > catchIndex) {
      contentLines.push(line);
    }

    if (foundOpenBrace && braceDepth === 0) {
      break;
    }
  }

  // Check if the catch block is effectively empty
  const contentStr = contentLines.join("\n").replace(/[{}]/g, "").trim();

  // Empty or only whitespace
  if (!contentStr) return true;

  // Only contains comments
  if (/^(\/\/.*|\s)*$/.test(contentStr)) return true;

  // Only contains a simple console.log/error with no other action
  if (/^(\s*console\.(log|error|warn)\([^)]*\);\s*)+$/.test(contentStr)) {
    // Check if it's just logging without rethrowing or handling
    if (!contentStr.includes("throw") && !contentStr.includes("return") && !contentStr.includes("reject")) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a line looks like a top-level declaration (no indentation).
 */
function isTopLevelDeclaration(line: string): boolean {
  // Must start with + (added line) followed by let, var, or const
  return /^\+(?:let|var|const)\s+\w+\s*=/.test(line);
}

/**
 * Extract variable name from a declaration line.
 */
function extractVariableName(line: string): string | null {
  const match = line.match(/^\+(?:let|var|const)\s+(\w+)\s*=/);
  return match ? match[1] : null;
}

/**
 * Check if a variable is mutated later in the patch.
 */
function isVariableMutatedLater(patchLines: string[], varName: string, startIndex: number): boolean {
  for (let i = startIndex + 1; i < patchLines.length; i++) {
    const line = patchLines[i] || "";
    if (!line.startsWith("+")) continue;

    // Check for mutations: .push(, [x] =, .prop =
    const mutationPatterns = [
      new RegExp(`${varName}\\.push\\(`),
      new RegExp(`${varName}\\[.+\\]\\s*=`),
      new RegExp(`${varName}\\.\\w+\\s*=`),
      new RegExp(`${varName}\\s*=\\s*`), // reassignment (for let/var)
    ];

    if (mutationPatterns.some((pattern) => pattern.test(line))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a file is a test file based on its name.
 */
function isTestFile(filename: string): boolean {
  return filename.includes(".test.") || filename.includes(".spec.") || filename.includes("__tests__");
}

// ============================================================================
// Scaling-focused helper functions
// ============================================================================

/**
 * Check if pagination/limit indicators exist nearby in the patch.
 */
function hasPaginationNearby(patchLines: string[], currentIndex: number, windowSize: number = 5): boolean {
  const start = Math.max(0, currentIndex - windowSize);
  const end = Math.min(patchLines.length, currentIndex + windowSize + 1);

  for (let i = start; i < end; i++) {
    const line = patchLines[i];
    if (line && PAGINATION_PATTERNS.some((pattern) => line.includes(pattern))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if batching indicators exist nearby in the patch.
 */
function hasBatchingNearby(patchLines: string[], currentIndex: number, windowSize: number = 8): boolean {
  const start = Math.max(0, currentIndex - windowSize);
  const end = Math.min(patchLines.length, currentIndex + windowSize + 1);

  for (let i = start; i < end; i++) {
    const line = patchLines[i];
    if (line && BATCHING_PATTERNS.some((pattern) => line.includes(pattern))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if we're in a request/handler context (for unbounded collection detection).
 */
function isInRequestContext(patchLines: string[], currentIndex: number, windowSize: number = 20): boolean {
  const start = Math.max(0, currentIndex - windowSize);

  for (let i = start; i < currentIndex; i++) {
    const line = patchLines[i];
    if (!line) continue;

    // Check for route handlers
    if (ROUTE_HANDLER_PATTERNS.some((pattern) => line.includes(pattern))) {
      return true;
    }
    // Check for req/res usage
    if (line.includes("req.") || line.includes("res.") || line.includes("request.") || line.includes("response.")) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Concurrency/Contention helper functions
// ============================================================================

/**
 * Check if a file write uses a hardcoded string literal path.
 */
function hasHardcodedFilePath(content: string): boolean {
  // Look for string literal paths in file write calls
  // Match patterns like: writeFile("./data.json", ...) or writeFileSync('/tmp/cache.txt', ...)
  return /(?:writeFile|appendFile)(?:Sync)?\s*\(\s*["'`][^"'`]+["'`]/.test(content);
}

/**
 * Check if backoff/jitter patterns exist nearby in the patch.
 */
function hasBackoffNearby(patchLines: string[], currentIndex: number, windowSize: number = 10): boolean {
  const start = Math.max(0, currentIndex - windowSize);
  const end = Math.min(patchLines.length, currentIndex + windowSize + 1);

  for (let i = start; i < end; i++) {
    const line = patchLines[i];
    if (line && BACKOFF_PATTERNS.some((pattern) => line.toLowerCase().includes(pattern.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if there's a delay/sleep/setTimeout nearby (for tight loop detection).
 */
function hasDelayInLoopBody(patchLines: string[], loopIndex: number, windowSize: number = 10): boolean {
  const end = Math.min(patchLines.length, loopIndex + windowSize + 1);

  for (let i = loopIndex + 1; i < end; i++) {
    const line = patchLines[i];
    if (!line) continue;

    // Check for delay patterns
    if (/setTimeout|sleep|await\s+delay|await\s+wait|await\s+new\s+Promise/.test(line)) {
      return true;
    }
    // Check for break/return which would exit the loop
    if (/\breturn\b|\bbreak\b/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an act pattern (create/insert) follows a check pattern (find/get) nearby.
 */
function hasActPatternNearby(patchLines: string[], checkIndex: number, windowSize: number = 8): boolean {
  const end = Math.min(patchLines.length, checkIndex + windowSize + 1);

  for (let i = checkIndex + 1; i < end; i++) {
    const line = patchLines[i];
    if (!line || !line.startsWith("+")) continue;

    if (ACT_PATTERNS.some((pattern) => line.includes(pattern))) {
      return true;
    }
  }
  return false;
}

/**
 * Extract a normalized "call signature" from a line for caching detection.
 * Returns null if no external call pattern is found.
 */
function extractCallSignature(content: string): string | null {
  for (const pattern of EXTERNAL_CALL_PATTERNS) {
    if (content.includes(pattern)) {
      // Try to extract the URL or call signature
      // Match fetch("url") or axios.get("url") etc.
      const urlMatch = content.match(/["'`]([^"'`]+)["'`]/);
      if (urlMatch) {
        return `${pattern}${urlMatch[1]}`;
      }
      // If no URL found, use the pattern + a hash of the line
      return `${pattern}:${content.trim().slice(0, 50)}`;
    }
  }
  return null;
}

/**
 * Check if there's I/O happening in the next few lines after a loop.
 */
function hasIOInLoopBody(patchLines: string[], loopIndex: number, windowSize: number = 8): boolean {
  const end = Math.min(patchLines.length, loopIndex + windowSize + 1);

  for (let i = loopIndex + 1; i < end; i++) {
    const line = patchLines[i];
    if (!line || !line.startsWith("+")) continue;

    if (IO_PATTERNS.some((pattern) => line.includes(pattern))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a file has a code extension we care about.
 */
function isCodeFile(filename: string): boolean {
  return CODE_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

/**
 * Collect response shape patterns from the patch for MIXED_RESPONSE_SHAPES detection.
 */
function collectResponseShapes(patchLines: string[]): { line: number; shape: string }[] {
  const shapes: { line: number; shape: string }[] = [];
  let currentLine = 0;

  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i] || "";

    const hunkStart = parseHunkHeader(line);
    if (hunkStart !== null) {
      currentLine = hunkStart;
      continue;
    }

    if (line.startsWith("+")) {
      // Look for res.json({ or res.send({ or return {
      const jsonMatch = line.match(/(?:res\.(?:json|send)|return)\s*\(\s*\{([^}]*)\}/);
      if (jsonMatch) {
        shapes.push({ line: currentLine, shape: jsonMatch[1].trim() });
      }
      currentLine++;
    } else if (!line.startsWith("-")) {
      currentLine++;
    }
  }

  return shapes;
}

/**
 * Extract keys from a simple object shape string.
 */
function extractKeys(shape: string): string[] {
  // Simple extraction of property names
  const keys: string[] = [];
  const matches = shape.matchAll(/(\w+)\s*:/g);
  for (const match of matches) {
    keys.push(match[1]);
  }
  return keys.sort();
}

/**
 * Check if two shapes are meaningfully different.
 */
function areShapesDifferent(shape1: string, shape2: string): boolean {
  const keys1 = extractKeys(shape1);
  const keys2 = extractKeys(shape2);

  if (keys1.length === 0 || keys2.length === 0) return false;
  if (keys1.length !== keys2.length) return true;

  return keys1.some((key, idx) => key !== keys2[idx]);
}

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
      const hasIOPattern = IO_PATTERNS.some((pattern) => content.includes(pattern));
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
        const hasDebugPattern = DEBUG_PATTERNS.some((pattern) => content.includes(pattern));
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
      const hasRequestInput = REQUEST_INPUT_PATTERNS.some((pattern) => content.includes(pattern));
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
          message: "Non-null assertion detected. Code is making strong assumptions about data shape that may not hold in production.",
          snippet: trimmedContent.slice(0, 100),
        });
      }
      // Type assertion on external data: as SomeType (heuristic)
      if (/as\s+\w+/.test(content) && REQUEST_INPUT_PATTERNS.some((p) => content.includes(p))) {
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
              if (lines[j]?.includes(pattern)) return true;
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
      const hasDbQueryPattern = DB_QUERY_PATTERNS.some((pattern) => content.includes(pattern));
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
      const hasCollectionProcessing = COLLECTION_PROCESSING_PATTERNS.some((pattern) => content.includes(pattern));
      if (hasCollectionProcessing && isInRequestContext(lines, i)) {
        // Check if it looks like processing a potentially large collection
        // (items, rows, users, messages, data, results, records, etc.)
        const largeCollectionHint = /\b(items|rows|users|messages|data|results|records|entries|documents|events|logs|orders|products)\b/i.test(content);
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
      const isLoopStart = LOOP_PATTERNS.some((pattern) => content.includes(pattern));
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
      const hasMemoryRiskPattern = MEMORY_RISK_PATTERNS.some((pattern) => content.includes(pattern));
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
      const hasFileWritePattern = FILE_WRITE_PATTERNS.some((pattern) => content.includes(pattern));
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
      const hasRetryPattern = RETRY_PATTERNS.some((pattern) => content.toLowerCase().includes(pattern.toLowerCase()));
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
      const hasTightLoopPattern = TIGHT_LOOP_PATTERNS.some((pattern) => content.includes(pattern));
      if (hasTightLoopPattern) {
        // Check if there's a delay inside the loop body
        if (!hasDelayInLoopBody(lines, i)) {
          findings.push({
            file,
            line: currentLine,
            severity: "high",
            kind: "BUSY_WAIT_OR_TIGHT_LOOP",
            message:
              "Tight loop without delay/sleep detected. This can peg CPU at 100% and starve other processes.",
            snippet: trimmedContent.slice(0, 100),
          });
        }
      }

      // ========================================
      // r) CHECK_THEN_ACT_RACE detection
      // ========================================
      const hasCheckPattern = CHECK_PATTERNS.some((pattern) => content.includes(pattern));
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

/**
 * Analyze all PR files and return aggregated findings.
 * Only analyzes files that look like code (based on extension).
 *
 * @deprecated Use analyzePullRequestPatchesWithConfig for config-aware analysis.
 */
export function analyzePullRequestPatches(files: { filename: string; patch?: string | null }[]): Finding[] {
  const allFindings: Finding[] = [];

  for (const file of files) {
    // Skip files without patches
    if (!file.patch) {
      continue;
    }

    // Only analyze code files
    if (!isCodeFile(file.filename)) {
      continue;
    }

    const fileFindings = analyzePatch(file.filename, file.patch);
    allFindings.push(...fileFindings);
  }

  return allFindings;
}

/**
 * Options for config-aware analysis.
 */
export interface AnalysisOptions {
  /**
   * The loaded configuration. If not provided, uses defaults.
   */
  config?: LoadedConfig;
}

/**
 * Analyze all PR files with config and suppression support.
 *
 * This is the preferred entry point for analysis that respects:
 * - .vibescan.yml configuration
 * - File ignore patterns
 * - Rule enable/disable settings
 * - Per-path rule overrides
 * - Inline suppression directives
 *
 * @param files - Array of files with filename and patch content
 * @param options - Analysis options including config
 * @returns Array of findings that passed config and suppression filters
 */
export function analyzePullRequestPatchesWithConfig(
  files: { filename: string; patch?: string | null }[],
  options: AnalysisOptions = {}
): Finding[] {
  const config = options.config ?? createDefaultConfig();
  const allFindings: Finding[] = [];

  for (const file of files) {
    // Skip files without patches
    if (!file.patch) {
      continue;
    }

    // Only analyze code files
    if (!isCodeFile(file.filename)) {
      continue;
    }

    // Check if file is ignored by config
    if (config.isFileIgnored(file.filename)) {
      continue;
    }

    // Get raw findings from the analyzer
    const rawFindings = analyzePatch(file.filename, file.patch);

    // Parse suppression directives from the patch content
    // Note: We extract added lines from the patch for suppression parsing
    const patchContent = extractAddedLinesFromPatch(file.patch);
    const suppressions = parseSuppressionDirectives(patchContent);

    // Check if file is in prototype zone
    const isInPrototypeZone = config.isPrototypeZone(file.filename);

    // Filter and enrich findings
    for (const finding of rawFindings) {
      // Check if the rule is enabled for this file
      if (isValidRuleId(finding.kind)) {
        const ruleConfig = config.getRuleConfig(finding.kind as RuleId, file.filename);

        // Skip if rule is disabled or level is "off"
        if (!ruleConfig.enabled || ruleConfig.level === "off") {
          continue;
        }

        // Check inline suppressions
        if (finding.line && isSuppressed(finding.kind as RuleId, finding.line, suppressions)) {
          continue;
        }

        // Enrich finding with level and prototype zone info
        allFindings.push({
          ...finding,
          level: ruleConfig.level,
          isPrototypeZone: isInPrototypeZone,
        });
      } else {
        // For non-standard rule kinds, only apply file-scope ALL suppression
        const hasAllSuppression = suppressions.some(
          (s) => s.scope === "file" && s.allRules
        );
        if (!hasAllSuppression) {
          allFindings.push({
            ...finding,
            isPrototypeZone: isInPrototypeZone,
          });
        }
      }
    }
  }

  return allFindings;
}

/**
 * Extract the content of added lines from a unified diff patch.
 * This reconstructs something close to the new file content for suppression parsing.
 *
 * @param patch - The unified diff patch string
 * @returns String containing the added lines (approximation of new content)
 */
function extractAddedLinesFromPatch(patch: string): string {
  const lines = patch.split("\n");
  const addedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      // Remove the leading "+" and add to our content
      addedLines.push(line.slice(1));
    } else if (!line.startsWith("-") && !line.startsWith("@@") && !line.startsWith("diff ")) {
      // Context lines (no prefix) - include them for proper line number tracking
      addedLines.push(line);
    }
  }

  return addedLines.join("\n");
}

/**
 * Re-export types and functions from core modules for convenience.
 */
export { RuleId, RuleLevel, isValidRuleId } from "./core/rules";
export { LoadedConfig, loadConfig, createDefaultConfig } from "./config/loadConfig";
export {
  parseSuppressionDirectives,
  isSuppressed,
  SuppressionDirective,
} from "./core/suppression";
