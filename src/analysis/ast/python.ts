/**
 * Python AST analyzer using tree-sitter.
 *
 * Tree-sitter is ideal for Python because:
 * - Handles partial/broken code gracefully
 * - Fast native parsing
 * - Handles significant whitespace correctly
 *
 * Handles: .py, .pyw
 */

import Parser from "tree-sitter";
import Python from "tree-sitter-python";

import {
  LanguageAnalyzer,
  ASTAnalysisResult,
  ASTFinding,
  CodeContext,
  SupportedLanguage,
} from "./types";
import { RuleId } from "../rules";
import { Severity } from "../analyzer";

// ============================================================================
// Pattern Constants for Python Analysis
// ============================================================================

/** I/O call patterns for Python */
const PYTHON_IO_PATTERNS = new Set([
  // HTTP clients
  "requests.get",
  "requests.post",
  "requests.put",
  "requests.delete",
  "requests.patch",
  "requests.head",
  "requests.options",
  "httpx.get",
  "httpx.post",
  "httpx.put",
  "httpx.delete",
  "httpx.AsyncClient",
  "aiohttp.ClientSession",
  "urllib.request.urlopen",
  // File operations
  "open",
  "read",
  "write",
  "readlines",
  // Database
  "cursor.execute",
  "cursor.executemany",
  "session.execute",
  "session.query",
  "connection.execute",
  // ORM patterns
  "objects.all",
  "objects.filter",
  "objects.get",
  "objects.create",
  "query",
  "execute",
]);

/** Unbounded query patterns */
const PYTHON_UNBOUNDED_PATTERNS = new Set([
  "objects.all",
  "objects.filter",
  "query",
  "find",
  "select",
  "fetchall",
]);

/** Pagination indicators */
const PYTHON_PAGINATION_PATTERNS = new Set([
  "limit",
  "offset",
  "slice",
  "first",
  "[:1]",
  "paginate",
  "page_size",
  "per_page",
]);

/** Blocking patterns (in async context) */
const PYTHON_BLOCKING_PATTERNS = new Set([
  "time.sleep",
  "os.system",
  "subprocess.run",
  "subprocess.call",
]);

// ============================================================================
// Python Analyzer Implementation
// ============================================================================

export class PythonAnalyzer implements LanguageAnalyzer {
  language: SupportedLanguage = "python";
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Python as unknown as Parser.Language);
  }

  canAnalyze(filePath: string): boolean {
    const ext = filePath.toLowerCase().split(".").pop();
    return ["py", "pyw"].includes(ext || "");
  }

  analyze(content: string, filePath: string, changedLines?: Set<number>): ASTAnalysisResult {
    const startTime = Date.now();
    const findings: ASTFinding[] = [];

    // Parse the file
    let tree: Parser.Tree;
    try {
      tree = this.parser.parse(content);
    } catch (error) {
      return {
        filePath,
        language: this.language,
        parseSuccess: false,
        parseError: error instanceof Error ? error.message : "Unknown parse error",
        findings: [],
        analysisTimeMs: Date.now() - startTime,
      };
    }

    const rootNode = tree.rootNode;

    // Run detection rules
    this.detectUnsafeIO(rootNode, content, findings, changedLines);
    this.detectLoopedIO(rootNode, content, findings, changedLines);
    this.detectUnboundedQueries(rootNode, content, findings, changedLines);
    this.detectSilentErrors(rootNode, content, findings, changedLines);
    this.detectGlobalMutation(rootNode, content, findings, changedLines);
    this.detectBlockingInAsync(rootNode, content, findings, changedLines);

    return {
      filePath,
      language: this.language,
      parseSuccess: true,
      findings,
      analysisTimeMs: Date.now() - startTime,
    };
  }

  // ==========================================================================
  // Tree-sitter Helper Methods
  // ==========================================================================

  private getNodeText(node: Parser.SyntaxNode, content: string): string {
    return content.slice(node.startIndex, node.endIndex);
  }

  private getLineNumber(node: Parser.SyntaxNode): number {
    return node.startPosition.row + 1; // tree-sitter is 0-indexed
  }

  private shouldReportLine(line: number, changedLines?: Set<number>): boolean {
    if (!changedLines) return true;
    return changedLines.has(line);
  }

  private findAncestor(node: Parser.SyntaxNode, types: string[]): Parser.SyntaxNode | null {
    let current = node.parent;
    while (current) {
      if (types.includes(current.type)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  private isInsideTryExcept(node: Parser.SyntaxNode): boolean {
    const tryStmt = this.findAncestor(node, ["try_statement"]);
    if (!tryStmt) return false;

    // Make sure we're in the try block, not except/finally
    for (const child of tryStmt.children) {
      if (child.type === "block") {
        if (this.isDescendantOf(node, child)) {
          return true;
        }
        break; // Only check the first block (the try block)
      }
    }
    return false;
  }

  private isInsideLoop(node: Parser.SyntaxNode): boolean {
    return this.findAncestor(node, ["for_statement", "while_statement", "list_comprehension", "generator_expression"]) !== null;
  }

  private isInsideAsyncFunction(node: Parser.SyntaxNode): boolean {
    const funcDef = this.findAncestor(node, ["function_definition"]);
    if (!funcDef) return false;

    // Check for async keyword
    for (const child of funcDef.children) {
      if (child.type === "async") {
        return true;
      }
    }
    return false;
  }

  private isAtModuleScope(node: Parser.SyntaxNode): boolean {
    return this.findAncestor(node, ["function_definition", "class_definition"]) === null;
  }

  private isInsideRouteHandler(node: Parser.SyntaxNode, content: string): boolean {
    const funcDef = this.findAncestor(node, ["function_definition"]);
    if (!funcDef) return false;

    // Check for decorators like @app.route, @router.get, etc.
    const parent = funcDef.parent;
    if (parent && parent.type === "decorated_definition") {
      for (const child of parent.children) {
        if (child.type === "decorator") {
          const decoratorText = this.getNodeText(child, content);
          if (
            decoratorText.includes("@app.") ||
            decoratorText.includes("@router.") ||
            decoratorText.includes("@blueprint.") ||
            decoratorText.includes("route")
          ) {
            return true;
          }
        }
      }
    }

    // Check for request parameter
    for (const child of funcDef.children) {
      if (child.type === "parameters") {
        const paramsText = this.getNodeText(child, content);
        if (paramsText.includes("request")) {
          return true;
        }
      }
    }

    return false;
  }

  private isDescendantOf(node: Parser.SyntaxNode, ancestor: Parser.SyntaxNode): boolean {
    let current = node.parent;
    while (current) {
      if (current === ancestor) return true;
      current = current.parent;
    }
    return false;
  }

  private getCodeContext(node: Parser.SyntaxNode, content: string): CodeContext {
    return {
      isInTryCatch: this.isInsideTryExcept(node),
      isInLoop: this.isInsideLoop(node),
      isInAsyncFunction: this.isInsideAsyncFunction(node),
      isModuleScope: this.isAtModuleScope(node),
      isInRouteHandler: this.isInsideRouteHandler(node, content),
      parentFunctionName: this.getParentFunctionName(node, content),
      enclosingClassName: this.getEnclosingClassName(node, content),
    };
  }

  private getParentFunctionName(node: Parser.SyntaxNode, content: string): string | undefined {
    const funcDef = this.findAncestor(node, ["function_definition"]);
    if (!funcDef) return undefined;

    for (const child of funcDef.children) {
      if (child.type === "identifier") {
        return this.getNodeText(child, content);
      }
    }
    return undefined;
  }

  private getEnclosingClassName(node: Parser.SyntaxNode, content: string): string | undefined {
    const classDef = this.findAncestor(node, ["class_definition"]);
    if (!classDef) return undefined;

    for (const child of classDef.children) {
      if (child.type === "identifier") {
        return this.getNodeText(child, content);
      }
    }
    return undefined;
  }

  private findAllNodes(root: Parser.SyntaxNode, types: string[]): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    const traverse = (node: Parser.SyntaxNode) => {
      if (types.includes(node.type)) {
        results.push(node);
      }
      for (const child of node.children) {
        traverse(child);
      }
    };
    traverse(root);
    return results;
  }

  // ==========================================================================
  // Detection Rules
  // ==========================================================================

  /**
   * UNSAFE_IO: I/O calls not in try/except
   */
  private detectUnsafeIO(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    const calls = this.findAllNodes(root, ["call"]);

    for (const call of calls) {
      const line = this.getLineNumber(call);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getNodeText(call, content);
      if (!this.isPythonIOCall(callText)) continue;

      const context = this.getCodeContext(call, content);

      // Skip if inside try/except
      if (context.isInTryCatch) continue;

      // Skip if inside loop (LOOPED_IO will catch it)
      if (context.isInLoop) continue;

      findings.push({
        ruleId: "UNSAFE_IO" as RuleId,
        line,
        severity: "high",
        message: "I/O operation without try/except error handling. Network and file operations should handle exceptions.",
        snippet: callText.slice(0, 100),
        context,
        confidence: "high",
      });
    }
  }

  /**
   * LOOPED_IO: I/O inside loops
   */
  private detectLoopedIO(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    const calls = this.findAllNodes(root, ["call"]);

    for (const call of calls) {
      const line = this.getLineNumber(call);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getNodeText(call, content);
      if (!this.isPythonIOCall(callText)) continue;

      const context = this.getCodeContext(call, content);

      if (context.isInLoop) {
        findings.push({
          ruleId: "LOOPED_IO" as RuleId,
          line,
          severity: "high",
          message:
            "I/O operation inside a loop. This causes N+1 problems and will not scale. Consider batching or using asyncio.gather().",
          snippet: callText.slice(0, 100),
          context,
          confidence: "high",
        });
      }
    }
  }

  /**
   * UNBOUNDED_QUERY: Queries without limit/pagination
   */
  private detectUnboundedQueries(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    const calls = this.findAllNodes(root, ["call"]);

    for (const call of calls) {
      const line = this.getLineNumber(call);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getNodeText(call, content);

      // Check for unbounded query patterns
      let isUnbounded = false;
      for (const pattern of PYTHON_UNBOUNDED_PATTERNS) {
        if (callText.includes(pattern)) {
          isUnbounded = true;
          break;
        }
      }

      if (!isUnbounded) continue;

      // Check for pagination in the chain or arguments
      let hasPagination = false;
      for (const pattern of PYTHON_PAGINATION_PATTERNS) {
        if (callText.includes(pattern)) {
          hasPagination = true;
          break;
        }
      }

      // Also check the parent statement for slice notation
      const stmt = this.findAncestor(call, ["expression_statement", "assignment"]);
      if (stmt) {
        const stmtText = this.getNodeText(stmt, content);
        if (stmtText.includes("[:") || stmtText.includes("limit") || stmtText.includes("first()")) {
          hasPagination = true;
        }
      }

      if (hasPagination) continue;

      const context = this.getCodeContext(call, content);

      findings.push({
        ruleId: "UNBOUNDED_QUERY" as RuleId,
        line,
        severity: "high",
        message:
          "Database query without pagination or limit. Add .limit(), [:n], or pagination to prevent loading unbounded data.",
        snippet: callText.slice(0, 100),
        context,
        confidence: "high",
      });
    }
  }

  /**
   * SILENT_ERROR: Empty or logging-only except blocks
   */
  private detectSilentErrors(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    const tryStatements = this.findAllNodes(root, ["try_statement"]);

    for (const tryStmt of tryStatements) {
      // Find except clauses
      for (const child of tryStmt.children) {
        if (child.type === "except_clause") {
          const line = this.getLineNumber(child);
          if (!this.shouldReportLine(line, changedLines)) continue;

          // Get the block inside except
          let exceptBlock: Parser.SyntaxNode | null = null;
          for (const exceptChild of child.children) {
            if (exceptChild.type === "block") {
              exceptBlock = exceptChild;
              break;
            }
          }

          if (!exceptBlock) continue;

          const blockText = this.getNodeText(exceptBlock, content);

          // Check if it's silent
          if (this.isSilentExceptBlock(blockText)) {
            const context = this.getCodeContext(child, content);

            findings.push({
              ruleId: "SILENT_ERROR" as RuleId,
              line,
              severity: "high",
              message:
                "Except block swallows errors silently. Errors are either ignored (pass) or only logged without being re-raised.",
              snippet: this.getNodeText(child, content).slice(0, 100),
              context,
              confidence: "high",
            });
          }
        }
      }
    }
  }

  /**
   * GLOBAL_MUTATION: Module-level mutable state
   */
  private detectGlobalMutation(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    // Find module-level assignments
    for (const child of root.children) {
      if (child.type === "expression_statement") {
        const assignmentNode = child.children.find((c) => c.type === "assignment");
        if (assignmentNode) {
          const line = this.getLineNumber(child);
          if (!this.shouldReportLine(line, changedLines)) continue;

          const assignText = this.getNodeText(assignmentNode, content);

          // Check if it's a mutable type (list, dict, set)
          if (
            assignText.includes("[") ||
            assignText.includes("{") ||
            assignText.includes("list(") ||
            assignText.includes("dict(") ||
            assignText.includes("set(")
          ) {
            // Get variable name
            const leftSide = assignmentNode.children[0];
            if (leftSide && leftSide.type === "identifier") {
              const varName = this.getNodeText(leftSide, content);

              // Check if this variable is mutated elsewhere
              if (this.isPythonVariableMutated(root, varName, content)) {
                const context = this.getCodeContext(child, content);

                findings.push({
                  ruleId: "GLOBAL_MUTATION" as RuleId,
                  line,
                  severity: "high",
                  message: `Module-level mutable state '${varName}' is modified. This causes concurrency bugs in web servers (shared state between requests).`,
                  snippet: assignText.slice(0, 100),
                  context,
                  confidence: "high",
                });
              }
            }
          }
        }
      }
    }
  }

  /**
   * BLOCKING_OPERATION: Blocking calls in async context
   */
  private detectBlockingInAsync(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    const calls = this.findAllNodes(root, ["call"]);

    for (const call of calls) {
      const line = this.getLineNumber(call);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getNodeText(call, content);

      let isBlocking = false;
      for (const pattern of PYTHON_BLOCKING_PATTERNS) {
        if (callText.includes(pattern)) {
          isBlocking = true;
          break;
        }
      }

      if (!isBlocking) continue;

      const context = this.getCodeContext(call, content);

      // Only flag if inside async function
      if (context.isInAsyncFunction) {
        findings.push({
          ruleId: "BLOCKING_OPERATION" as RuleId,
          line,
          severity: "high",
          message:
            "Blocking operation inside async function. Use asyncio.sleep(), aiofiles, or run_in_executor() instead.",
          snippet: callText.slice(0, 100),
          context,
          confidence: "high",
        });
      } else {
        // Still flag time.sleep in web handlers as it blocks the worker
        if (callText.includes("time.sleep") && context.isInRouteHandler) {
          findings.push({
            ruleId: "BLOCKING_OPERATION" as RuleId,
            line,
            severity: "medium",
            message: "time.sleep() in request handler blocks the worker thread. Consider async alternatives.",
            snippet: callText.slice(0, 100),
            context,
            confidence: "medium",
          });
        }
      }
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private isPythonIOCall(callText: string): boolean {
    for (const pattern of PYTHON_IO_PATTERNS) {
      if (callText.includes(pattern)) return true;
    }

    // Check for common I/O patterns
    if (callText.match(/requests\.\w+\(/)) return true;
    if (callText.match(/httpx\.\w+\(/)) return true;
    if (callText.match(/cursor\.execute/)) return true;
    if (callText.match(/session\.query/)) return true;
    if (callText.includes("open(")) return true;
    if (callText.includes(".read(")) return true;
    if (callText.includes(".write(")) return true;

    return false;
  }

  private isSilentExceptBlock(blockText: string): boolean {
    const trimmed = blockText.trim();

    // Just pass
    if (trimmed === "pass" || trimmed.endsWith(":pass") || /^\s*pass\s*$/.test(trimmed)) {
      return true;
    }

    // Just ellipsis (...)
    if (trimmed === "..." || /^\s*\.\.\.\s*$/.test(trimmed)) {
      return true;
    }

    // Only logging without raise
    if (!trimmed.includes("raise") && !trimmed.includes("return") && !trimmed.includes("sys.exit")) {
      // Check if it's just print/logging
      const lines = trimmed.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
      const allLogging = lines.every(
        (l) =>
          l.trim().startsWith("print(") ||
          l.trim().startsWith("logging.") ||
          l.trim().startsWith("logger.") ||
          l.trim().startsWith("log.") ||
          l.trim() === "pass"
      );
      if (allLogging && lines.length > 0) {
        return true;
      }
    }

    return false;
  }

  private isPythonVariableMutated(root: Parser.SyntaxNode, varName: string, content: string): boolean {
    // Find all calls and assignments that might mutate this variable
    const allNodes = this.findAllNodes(root, ["call", "assignment", "augmented_assignment"]);

    for (const node of allNodes) {
      // Skip if this is at module scope (the original definition)
      if (node.parent === root) continue;

      const nodeText = this.getNodeText(node, content);

      // Check for mutation patterns
      if (
        nodeText.includes(`${varName}.append(`) ||
        nodeText.includes(`${varName}.extend(`) ||
        nodeText.includes(`${varName}.insert(`) ||
        nodeText.includes(`${varName}.pop(`) ||
        nodeText.includes(`${varName}.remove(`) ||
        nodeText.includes(`${varName}.clear(`) ||
        nodeText.includes(`${varName}.update(`) ||
        nodeText.includes(`${varName}.add(`) ||
        nodeText.includes(`${varName}[`)
      ) {
        return true;
      }

      // Check for augmented assignment (+=, etc.)
      if (node.type === "augmented_assignment" && nodeText.startsWith(varName)) {
        return true;
      }
    }

    return false;
  }
}

/**
 * Create and export a singleton instance for convenience.
 */
export const pythonAnalyzer = new PythonAnalyzer();
