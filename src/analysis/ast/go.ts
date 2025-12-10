/**
 * Go AST analyzer using tree-sitter.
 *
 * Go is popular for backend services, CLIs, and DevOps tools.
 * Common vibe-coded patterns in Go:
 * - Ignoring errors (_, _ = someFunc())
 * - Missing error handling
 * - Unbounded goroutines
 * - Global mutable state
 *
 * Handles: .go
 */

import Parser from "tree-sitter";
import Go from "tree-sitter-go";

import {
  LanguageAnalyzer,
  ASTAnalysisResult,
  ASTFinding,
  CodeContext,
  SupportedLanguage,
  IgnoredRange,
} from "./types";
import { RuleId } from "../rules";

// ============================================================================
// Pattern Constants for Go Analysis
// ============================================================================

/** I/O call patterns for Go */
const GO_IO_PATTERNS = new Set([
  // HTTP
  "http.Get",
  "http.Post",
  "http.Do",
  "http.NewRequest",
  "client.Do",
  "client.Get",
  "client.Post",
  // File I/O
  "os.Open",
  "os.Create",
  "os.ReadFile",
  "os.WriteFile",
  "ioutil.ReadFile",
  "ioutil.WriteFile",
  "ioutil.ReadAll",
  "io.ReadAll",
  "io.Copy",
  // Database
  "db.Query",
  "db.QueryRow",
  "db.Exec",
  "db.Prepare",
  "rows.Scan",
  "tx.Query",
  "tx.Exec",
  // Network
  "net.Dial",
  "net.Listen",
  "conn.Read",
  "conn.Write",
]);

/** Database query patterns */
const GO_QUERY_PATTERNS = new Set([
  "db.Query",
  "db.QueryRow",
  "tx.Query",
  "Find",
  "Where",
  "Select",
]);

/** Patterns that indicate pagination/limits */
const GO_PAGINATION_PATTERNS = new Set([
  "Limit",
  "LIMIT",
  "Offset",
  "OFFSET",
  "First",
  "Take",
  "Page",
]);

// ============================================================================
// Go Analyzer Implementation
// ============================================================================

export class GoAnalyzer implements LanguageAnalyzer {
  language: SupportedLanguage = "go";
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.parser.setLanguage(Go as any);
  }

  canAnalyze(filePath: string): boolean {
    return filePath.toLowerCase().endsWith(".go");
  }

  getIgnoredRanges(content: string): IgnoredRange[] | null {
    const ranges: IgnoredRange[] = [];

    let tree: Parser.Tree;
    try {
      tree = this.parser.parse(content);
    } catch {
      return null;
    }

    const rootNode = tree.rootNode;

    // Helper to collect all nodes of given types
    const collectNodes = (node: Parser.SyntaxNode, types: Set<string>): Parser.SyntaxNode[] => {
      const result: Parser.SyntaxNode[] = [];
      if (types.has(node.type)) {
        result.push(node);
      }
      for (const child of node.children) {
        result.push(...collectNodes(child, types));
      }
      return result;
    };

    // Go comment types: comment (single-line //), comment (multi-line /* */)
    const commentTypes = new Set(["comment"]);
    const comments = collectNodes(rootNode, commentTypes);
    for (const comment of comments) {
      ranges.push({
        startLine: comment.startPosition.row + 1,
        endLine: comment.endPosition.row + 1,
        startColumn: comment.startPosition.column + 1,
        endColumn: comment.endPosition.column + 1,
        type: "comment",
      });
    }

    // Go string types: interpreted_string_literal, raw_string_literal
    const stringTypes = new Set(["interpreted_string_literal", "raw_string_literal"]);
    const strings = collectNodes(rootNode, stringTypes);
    for (const str of strings) {
      ranges.push({
        startLine: str.startPosition.row + 1,
        endLine: str.endPosition.row + 1,
        startColumn: str.startPosition.column + 1,
        endColumn: str.endPosition.column + 1,
        type: "string",
      });
    }

    return ranges;
  }

  analyze(content: string, filePath: string, changedLines?: Set<number>): ASTAnalysisResult {
    const startTime = Date.now();
    const findings: ASTFinding[] = [];

    // Skip test files for some rules
    const isTestFile = filePath.includes("_test.go");

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
    this.detectIgnoredErrors(rootNode, content, findings, changedLines);
    this.detectUnsafeIO(rootNode, content, findings, changedLines);
    this.detectLoopedIO(rootNode, content, findings, changedLines);
    this.detectUnboundedQueries(rootNode, content, findings, changedLines);
    this.detectGlobalMutation(rootNode, content, findings, changedLines);
    if (!isTestFile) {
      this.detectSilentErrors(rootNode, content, findings, changedLines);
    }

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
    return node.startPosition.row + 1;
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

  private isInsideFunction(node: Parser.SyntaxNode): boolean {
    return this.findAncestor(node, ["function_declaration", "method_declaration", "func_literal"]) !== null;
  }

  private isInsideLoop(node: Parser.SyntaxNode): boolean {
    return this.findAncestor(node, ["for_statement", "range_clause"]) !== null;
  }

  private isAtPackageScope(node: Parser.SyntaxNode): boolean {
    return !this.isInsideFunction(node);
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

  private getCodeContext(node: Parser.SyntaxNode, content: string): CodeContext {
    return {
      isInTryCatch: false, // Go doesn't have try/catch
      isInLoop: this.isInsideLoop(node),
      isInAsyncFunction: false,
      isModuleScope: this.isAtPackageScope(node),
      isInRouteHandler: this.isInsideHTTPHandler(node, content),
      parentFunctionName: this.getParentFunctionName(node, content),
    };
  }

  private isInsideHTTPHandler(node: Parser.SyntaxNode, content: string): boolean {
    const funcDecl = this.findAncestor(node, ["function_declaration", "method_declaration"]);
    if (!funcDecl) return false;

    const funcText = this.getNodeText(funcDecl, content);
    // Check for http.HandlerFunc signature or ServeHTTP method
    return funcText.includes("http.ResponseWriter") || funcText.includes("*http.Request");
  }

  private getParentFunctionName(node: Parser.SyntaxNode, content: string): string | undefined {
    const funcDecl = this.findAncestor(node, ["function_declaration", "method_declaration"]);
    if (!funcDecl) return undefined;

    for (const child of funcDecl.children) {
      if (child.type === "identifier") {
        return this.getNodeText(child, content);
      }
    }
    return undefined;
  }

  // ==========================================================================
  // Detection Rules
  // ==========================================================================

  /**
   * Detect ignored errors: _, _ = someFunc() or _ = someFunc()
   * This is a very common vibe-code pattern in Go
   */
  private detectIgnoredErrors(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    // Look for short_var_declaration and assignment_statement with blank identifiers
    const assignments = this.findAllNodes(root, ["short_var_declaration", "assignment_statement"]);

    for (const assignment of assignments) {
      const line = this.getLineNumber(assignment);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const assignText = this.getNodeText(assignment, content);

      // Check for blank identifier pattern
      // Common patterns: _, _ = foo(), _ = foo(), _, err = foo() but err is unused
      if (assignText.includes("_, _") || /^_\s*[=:]/.test(assignText.trim())) {
        // Check if this is an I/O or error-returning function
        if (this.isIOCall(assignText) || this.looksLikeErrorReturningCall(assignText)) {
          const context = this.getCodeContext(assignment, content);

          findings.push({
            ruleId: "SILENT_ERROR" as RuleId,
            line,
            severity: "high",
            message: "Error explicitly ignored with blank identifier. Go errors should be handled, not discarded.",
            snippet: assignText.slice(0, 100),
            context,
            confidence: "high",
          });
        }
      }
    }
  }

  /**
   * UNSAFE_IO: I/O calls where error is not checked
   */
  private detectUnsafeIO(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    const calls = this.findAllNodes(root, ["call_expression"]);

    for (const call of calls) {
      const line = this.getLineNumber(call);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getNodeText(call, content);
      if (!this.isIOCall(callText)) continue;

      // Skip if inside loop (LOOPED_IO will catch it)
      const context = this.getCodeContext(call, content);
      if (context.isInLoop) continue;

      // Check if error is being handled (look at parent assignment)
      const parent = call.parent;
      if (parent && (parent.type === "short_var_declaration" || parent.type === "assignment_statement")) {
        const parentText = this.getNodeText(parent, content);
        // If it's properly assigned (not to blank identifier), assume it's handled
        if (!parentText.includes("_, _") && !parentText.startsWith("_")) {
          // Check if err is used in an if statement nearby
          const block = this.findAncestor(call, ["block"]);
          if (block) {
            const blockText = this.getNodeText(block, content);
            if (blockText.includes("if err !=") || blockText.includes("if err ==")) {
              continue;
            }
          }
        }
      }

      // If call is standalone (result discarded), flag it
      if (parent && parent.type === "expression_statement") {
        findings.push({
          ruleId: "UNSAFE_IO" as RuleId,
          line,
          severity: "high",
          message: "I/O operation result and error not captured. Errors may be silently lost.",
          snippet: callText.slice(0, 100),
          context,
          confidence: "high",
        });
      }
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
    const calls = this.findAllNodes(root, ["call_expression"]);

    for (const call of calls) {
      const line = this.getLineNumber(call);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getNodeText(call, content);
      if (!this.isIOCall(callText)) continue;

      const context = this.getCodeContext(call, content);

      if (context.isInLoop) {
        findings.push({
          ruleId: "LOOPED_IO" as RuleId,
          line,
          severity: "high",
          message:
            "I/O operation inside a loop. Consider batching queries or using goroutines with proper concurrency control.",
          snippet: callText.slice(0, 100),
          context,
          confidence: "high",
        });
      }
    }
  }

  /**
   * UNBOUNDED_QUERY: Queries without LIMIT
   */
  private detectUnboundedQueries(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    const calls = this.findAllNodes(root, ["call_expression"]);

    for (const call of calls) {
      const line = this.getLineNumber(call);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getNodeText(call, content);

      // Check for query patterns
      let isQuery = false;
      for (const pattern of GO_QUERY_PATTERNS) {
        if (callText.includes(pattern)) {
          isQuery = true;
          break;
        }
      }

      if (!isQuery) continue;

      // Check for pagination nearby
      const stmt = this.findAncestor(call, ["expression_statement", "short_var_declaration", "assignment_statement"]);
      let hasPagination = false;
      if (stmt) {
        const stmtText = this.getNodeText(stmt, content);
        for (const pattern of GO_PAGINATION_PATTERNS) {
          if (stmtText.includes(pattern)) {
            hasPagination = true;
            break;
          }
        }
      }

      if (hasPagination) continue;

      const context = this.getCodeContext(call, content);

      findings.push({
        ruleId: "UNBOUNDED_QUERY" as RuleId,
        line,
        severity: "high",
        message: "Database query without LIMIT. Consider adding pagination to prevent loading unbounded data.",
        snippet: callText.slice(0, 100),
        context,
        confidence: "medium",
      });
    }
  }

  /**
   * GLOBAL_MUTATION: Package-level mutable variables
   */
  private detectGlobalMutation(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    // Find package-level var declarations
    const varDecls = this.findAllNodes(root, ["var_declaration"]);

    for (const decl of varDecls) {
      // Skip if inside a function
      if (this.isInsideFunction(decl)) continue;

      const line = this.getLineNumber(decl);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const declText = this.getNodeText(decl, content);

      // Skip if it's a const-like pattern (all caps suggests constant)
      if (/var\s+[A-Z_]+\s*=/.test(declText)) continue;

      // Check if it's a mutable type (slice, map, pointer)
      if (
        declText.includes("[]") ||
        declText.includes("map[") ||
        declText.includes("*") ||
        declText.includes("= make(") ||
        declText.includes("= &")
      ) {
        const context = this.getCodeContext(decl, content);

        findings.push({
          ruleId: "GLOBAL_MUTATION" as RuleId,
          line,
          severity: "high",
          message:
            "Package-level mutable state detected. This can cause race conditions in concurrent Go programs.",
          snippet: declText.slice(0, 100),
          context,
          confidence: "high",
        });
      }
    }
  }

  /**
   * SILENT_ERROR: Error variables that are never used
   */
  private detectSilentErrors(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    // This is handled by detectIgnoredErrors for the explicit _ pattern
    // Here we could add more sophisticated unused error detection
    // but that requires more complex analysis
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private isIOCall(callText: string): boolean {
    for (const pattern of GO_IO_PATTERNS) {
      if (callText.includes(pattern)) return true;
    }
    return false;
  }

  private looksLikeErrorReturningCall(text: string): boolean {
    // Most Go functions that return errors have certain naming patterns
    return (
      text.includes("Read") ||
      text.includes("Write") ||
      text.includes("Open") ||
      text.includes("Close") ||
      text.includes("Query") ||
      text.includes("Exec") ||
      text.includes("Parse") ||
      text.includes("Unmarshal") ||
      text.includes("Marshal") ||
      text.includes("Dial") ||
      text.includes("Listen")
    );
  }
}

/**
 * Create and export a singleton instance.
 */
export const goAnalyzer = new GoAnalyzer();
