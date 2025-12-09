/**
 * Helper functions for static analysis detection.
 *
 * These functions support the main analyzer by providing pattern matching,
 * context detection, and code analysis utilities.
 */

import {
  CODE_EXTENSIONS,
  ERROR_HANDLING_PATTERNS,
  VALIDATION_PATTERNS,
  ROUTE_HANDLER_PATTERNS,
  LOOP_PATTERNS,
  ASYNC_PATTERNS,
  IO_PATTERNS,
  PAGINATION_PATTERNS,
  BATCHING_PATTERNS,
  BACKOFF_PATTERNS,
  ACT_PATTERNS,
  EXTERNAL_CALL_PATTERNS,
} from "./patterns";

/**
 * Parse the starting line number from a unified diff hunk header.
 * Format: @@ -a,b +c,d @@ or @@ -a +c @@
 * Returns the starting line number for added lines (c).
 */
export function parseHunkHeader(line: string): number | null {
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
export function hasErrorHandlingNearby(
  patchLines: string[],
  currentIndex: number,
  windowSize: number = 5
): boolean {
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
export function hasValidationNearby(
  patchLines: string[],
  currentIndex: number,
  windowSize: number = 8
): boolean {
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
export function isInRouteHandlerContext(
  patchLines: string[],
  currentIndex: number,
  windowSize: number = 15
): boolean {
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
export function hasLoopNearby(
  patchLines: string[],
  currentIndex: number,
  windowSize: number = 8
): boolean {
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
export function isInAsyncContext(
  patchLines: string[],
  currentIndex: number,
  windowSize: number = 20
): boolean {
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
export function isSilentCatch(patchLines: string[], catchIndex: number): boolean {
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
export function isTopLevelDeclaration(line: string): boolean {
  // Must start with + (added line) followed by let, var, or const
  return /^\+(?:let|var|const)\s+\w+\s*=/.test(line);
}

/**
 * Extract variable name from a declaration line.
 */
export function extractVariableName(line: string): string | null {
  const match = line.match(/^\+(?:let|var|const)\s+(\w+)\s*=/);
  return match ? match[1] : null;
}

/**
 * Check if a variable is mutated later in the patch.
 */
export function isVariableMutatedLater(
  patchLines: string[],
  varName: string,
  startIndex: number
): boolean {
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
export function isTestFile(filename: string): boolean {
  return filename.includes(".test.") || filename.includes(".spec.") || filename.includes("__tests__");
}

// ============================================================================
// Scaling-focused helper functions
// ============================================================================

/**
 * Check if pagination/limit indicators exist nearby in the patch.
 */
export function hasPaginationNearby(
  patchLines: string[],
  currentIndex: number,
  windowSize: number = 5
): boolean {
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
export function hasBatchingNearby(
  patchLines: string[],
  currentIndex: number,
  windowSize: number = 8
): boolean {
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
export function isInRequestContext(
  patchLines: string[],
  currentIndex: number,
  windowSize: number = 20
): boolean {
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
export function hasHardcodedFilePath(content: string): boolean {
  // Look for string literal paths in file write calls
  // Match patterns like: writeFile("./data.json", ...) or writeFileSync('/tmp/cache.txt', ...)
  return /(?:writeFile|appendFile)(?:Sync)?\s*\(\s*["'`][^"'`]+["'`]/.test(content);
}

/**
 * Check if backoff/jitter patterns exist nearby in the patch.
 */
export function hasBackoffNearby(
  patchLines: string[],
  currentIndex: number,
  windowSize: number = 10
): boolean {
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
export function hasDelayInLoopBody(
  patchLines: string[],
  loopIndex: number,
  windowSize: number = 10
): boolean {
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
export function hasActPatternNearby(
  patchLines: string[],
  checkIndex: number,
  windowSize: number = 8
): boolean {
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
export function extractCallSignature(content: string): string | null {
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
export function hasIOInLoopBody(
  patchLines: string[],
  loopIndex: number,
  windowSize: number = 8
): boolean {
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
export function isCodeFile(filename: string): boolean {
  return CODE_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

/**
 * Collect response shape patterns from the patch for MIXED_RESPONSE_SHAPES detection.
 */
export function collectResponseShapes(patchLines: string[]): { line: number; shape: string }[] {
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
export function extractKeys(shape: string): string[] {
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
export function areShapesDifferent(shape1: string, shape2: string): boolean {
  const keys1 = extractKeys(shape1);
  const keys2 = extractKeys(shape2);

  if (keys1.length === 0 || keys2.length === 0) return false;
  if (keys1.length !== keys2.length) return true;

  return keys1.some((key, idx) => key !== keys2[idx]);
}

/**
 * Extract the content of added lines from a unified diff patch.
 * This reconstructs something close to the new file content for suppression parsing.
 */
export function extractAddedLinesFromPatch(patch: string): string {
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
