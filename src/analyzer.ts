/**
 * Static analyzer for detecting "vibe-coded" or AI-generated prototype code
 * that may be risky for production (technical debt, scaling, reliability issues).
 *
 * This is a simple heuristic-based analyzer - no AST parsing or LLM involved.
 */

export type Severity = "low" | "medium" | "high";

export interface Finding {
  file: string;
  line?: number;
  severity: Severity;
  kind: string; // e.g., "TEMPORARY_HACK", "UNSAFE_IO", "CONSOLE_DEBUG"
  message: string; // short human-readable description
  snippet?: string; // optional short code snippet
}

// Maximum findings per file to avoid overwhelming output
const MAX_FINDINGS_PER_FILE = 50;

// Code file extensions we care about
const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rb", ".java"];

// Patterns for I/O operations that should have error handling
const IO_PATTERNS = ["fetch(", "axios.", "request(", "fs.", "client.query(", "db.", "execute("];

// Patterns that indicate error handling is present
const ERROR_HANDLING_PATTERNS = ["try", "catch", ".catch("];

// Debug logging patterns
const DEBUG_PATTERNS = ["console.log", "console.error", "console.warn", "print("];

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
 * Check if a file is a test file based on its name.
 */
function isTestFile(filename: string): boolean {
  return filename.includes(".test.") || filename.includes(".spec.") || filename.includes("__tests__");
}

/**
 * Check if a file has a code extension we care about.
 */
function isCodeFile(filename: string): boolean {
  return CODE_EXTENSIONS.some((ext) => filename.endsWith(ext));
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

      // a) TEMPORARY_HACK detection
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

      // b) UNSAFE_IO detection
      const hasIOPattern = IO_PATTERNS.some((pattern) => content.includes(pattern));
      if (hasIOPattern) {
        // Check if there's error handling nearby in the patch
        if (!hasErrorHandlingNearby(lines, i)) {
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

      // c) CONSOLE_DEBUG detection (only for non-test files)
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

      currentLine++;
    } else if (line.startsWith("-")) {
      // Removed line - don't increment line counter
      continue;
    } else {
      // Context line (no prefix) - increment line counter
      currentLine++;
    }
  }

  return findings;
}

/**
 * Analyze all PR files and return aggregated findings.
 * Only analyzes files that look like code (based on extension).
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
