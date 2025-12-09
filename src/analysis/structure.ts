/**
 * Structure Extractor - Lightweight code structure analysis for LLM context.
 *
 * Extracts imports, definitions, and basic stats from code files
 * to provide context without sending full file contents.
 */

/**
 * Patterns for extracting imports/dependencies.
 */
const IMPORT_PATTERNS = [
  // JavaScript/TypeScript imports
  /^import\s+.*$/,
  /^import\s*{[^}]*}\s*from\s*['"][^'"]+['"]/,
  /^import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]+['"]/,
  /^import\s+['"][^'"]+['"]/,
  // CommonJS require
  /^(?:const|let|var)\s+(?:{[^}]*}|\w+)\s*=\s*require\s*\(['"][^'"]+['"]\)/,
  /^require\s*\(['"][^'"]+['"]\)/,
  // Python imports
  /^import\s+[\w.]+(?:\s+as\s+\w+)?$/,
  /^from\s+[\w.]+\s+import\s+.+$/,
  // C# using
  /^using\s+[\w.]+;$/,
];

/**
 * Patterns for extracting definitions with their signatures.
 */
const DEFINITION_PATTERNS: { pattern: RegExp; type: string }[] = [
  // TypeScript/JavaScript classes
  { pattern: /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+\w+/, type: "class" },
  { pattern: /^(?:abstract\s+)?class\s+\w+/, type: "class" },
  // TypeScript interfaces
  { pattern: /^export\s+interface\s+\w+/, type: "interface" },
  { pattern: /^interface\s+\w+/, type: "interface" },
  // TypeScript type aliases
  { pattern: /^export\s+type\s+\w+\s*=/, type: "type" },
  { pattern: /^type\s+\w+\s*=/, type: "type" },
  // Exported functions
  { pattern: /^export\s+(?:default\s+)?(?:async\s+)?function\s+\w+/, type: "function" },
  { pattern: /^export\s+(?:default\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/, type: "function" },
  { pattern: /^export\s+(?:default\s+)?const\s+\w+\s*=\s*(?:async\s*)?(?:<[^>]+>)?\s*\(/, type: "function" },
  // Exported constants (non-function)
  { pattern: /^export\s+const\s+\w+\s*(?::\s*[^=]+)?\s*=\s*(?!(?:async\s*)?\()/, type: "const" },
  // Method signatures within classes (indented)
  { pattern: /^\s+(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\w+\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?(?:\s*\{)?$/, type: "method" },
  // Python class definitions
  { pattern: /^class\s+\w+(?:\([^)]*\))?:/, type: "class" },
  // Python function definitions
  { pattern: /^(?:async\s+)?def\s+\w+\s*\([^)]*\)/, type: "function" },
  // Python decorated functions/classes
  { pattern: /^@\w+(?:\([^)]*\))?$/, type: "decorator" },
];

/**
 * Extract the first meaningful part of a line for display.
 * Trims and truncates long lines.
 */
function formatLine(line: string, maxLength: number = 80): string {
  const trimmed = line.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  // Find a good break point
  const breakPoints = [" {", "(", " =>", " ="];
  for (const bp of breakPoints) {
    const idx = trimmed.indexOf(bp);
    if (idx > 0 && idx < maxLength) {
      return trimmed.slice(0, idx + bp.length) + "...";
    }
  }
  return trimmed.slice(0, maxLength) + "...";
}

/**
 * Check if a line matches any import pattern.
 */
function isImportLine(line: string): boolean {
  const trimmed = line.trim();
  return IMPORT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Check if a line matches a definition pattern and return the type.
 */
function getDefinitionType(line: string): string | null {
  const trimmed = line.trim();
  for (const { pattern, type } of DEFINITION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return type;
    }
  }
  return null;
}

/**
 * Determine the language from filename extension.
 */
function getLanguage(filename: string): "typescript" | "javascript" | "python" | "other" {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    default:
      return "other";
  }
}

/**
 * Extract structural information from a code file.
 *
 * @param content - The file content as a string
 * @param filename - The filename (used for language detection and display)
 * @returns A markdown-formatted summary of the file structure
 */
export function extractFileStructure(content: string, filename: string): string {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const language = getLanguage(filename);

  const imports: string[] = [];
  const definitions: { type: string; line: string }[] = [];
  let pendingDecorator: string | null = null;
  let inMultiLineImport = false;
  let multiLineImportBuffer = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments (unless in multi-line import)
    if (!inMultiLineImport && (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*"))) {
      continue;
    }

    // Handle multi-line imports
    if (inMultiLineImport) {
      multiLineImportBuffer += " " + trimmed;
      if (trimmed.includes(";") || (trimmed.includes("from") && trimmed.includes("'"))) {
        // Extract just the module name from multi-line import
        const fromMatch = multiLineImportBuffer.match(/from\s*['"]([^'"]+)['"]/);
        if (fromMatch) {
          imports.push(`import { ... } from '${fromMatch[1]}'`);
        } else {
          imports.push(formatLine(multiLineImportBuffer));
        }
        inMultiLineImport = false;
        multiLineImportBuffer = "";
      }
      continue;
    }

    // Check for imports
    if (isImportLine(line)) {
      // Check if this is a multi-line import (has { but no closing } on same line)
      if (trimmed.includes("{") && !trimmed.includes("}") && !trimmed.includes("from")) {
        inMultiLineImport = true;
        multiLineImportBuffer = trimmed;
        continue;
      }
      imports.push(formatLine(trimmed));
      continue;
    }

    // Check for definitions
    const defType = getDefinitionType(line);
    if (defType) {
      if (defType === "decorator") {
        // Store decorator to attach to next definition
        pendingDecorator = formatLine(trimmed);
        continue;
      }

      // Skip private methods (those starting with underscore or private keyword)
      if (defType === "method" && (trimmed.includes("private ") || /^\s*_\w+/.test(trimmed))) {
        pendingDecorator = null;
        continue;
      }

      let formattedLine = formatLine(trimmed);
      if (pendingDecorator) {
        formattedLine = `${pendingDecorator} ${formattedLine}`;
        pendingDecorator = null;
      }

      definitions.push({ type: defType, line: formattedLine });
    } else {
      // Reset pending decorator if we hit a non-definition line
      if (pendingDecorator && trimmed.length > 0 && !trimmed.startsWith("@")) {
        pendingDecorator = null;
      }
    }
  }

  // Build the markdown output
  const output: string[] = [];
  output.push(`## File Structure: ${filename}`);
  output.push("");

  // Stats line
  const stats: string[] = [`Total lines: ${totalLines}`];
  if (imports.length > 0) stats.push(`Imports: ${imports.length}`);
  if (definitions.length > 0) stats.push(`Definitions: ${definitions.length}`);
  output.push(`*${stats.join(" | ")}*`);
  output.push("");

  // Imports section (limit to avoid overwhelming output)
  if (imports.length > 0) {
    output.push("### Imports");
    const importLimit = 10;
    const displayImports = imports.slice(0, importLimit);
    for (const imp of displayImports) {
      output.push(`- \`${imp}\``);
    }
    if (imports.length > importLimit) {
      output.push(`- *... and ${imports.length - importLimit} more imports*`);
    }
    output.push("");
  }

  // Definitions section
  if (definitions.length > 0) {
    output.push("### Definitions");
    const defLimit = 20;
    const displayDefs = definitions.slice(0, defLimit);
    for (const def of displayDefs) {
      output.push(`- ${capitalize(def.type)}: \`${def.line}\``);
    }
    if (definitions.length > defLimit) {
      output.push(`- *... and ${definitions.length - defLimit} more definitions*`);
    }
    output.push("");
  }

  return output.join("\n");
}

/**
 * Capitalize the first letter of a string.
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Extract a compact structure summary (single line) for inline context.
 * Useful for embedding in prompts where space is limited.
 */
export function extractCompactStructure(content: string, filename: string): string {
  const lines = content.split("\n");
  const totalLines = lines.length;

  let classCount = 0;
  let functionCount = 0;
  let importCount = 0;

  for (const line of lines) {
    if (isImportLine(line)) {
      importCount++;
      continue;
    }
    const defType = getDefinitionType(line);
    if (defType === "class") classCount++;
    if (defType === "function" || defType === "method") functionCount++;
  }

  const parts: string[] = [`${totalLines} lines`];
  if (importCount > 0) parts.push(`${importCount} imports`);
  if (classCount > 0) parts.push(`${classCount} class${classCount > 1 ? "es" : ""}`);
  if (functionCount > 0) parts.push(`${functionCount} fn${functionCount > 1 ? "s" : ""}`);

  return `${filename}: ${parts.join(", ")}`;
}
