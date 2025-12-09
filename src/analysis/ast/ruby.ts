/**
 * Ruby AST analyzer using tree-sitter.
 *
 * Ruby/Rails is commonly used for MVPs and prototypes.
 * Common vibe-coded patterns:
 * - N+1 queries in controllers
 * - Missing error handling around HTTP calls
 * - Global mutable state
 * - Unbounded ActiveRecord queries
 *
 * Handles: .rb, .rake, .ru
 */

import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";

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
// Pattern Constants for Ruby Analysis
// ============================================================================

/** I/O call patterns for Ruby */
const RUBY_IO_PATTERNS = new Set([
  // HTTP
  "Net::HTTP",
  "HTTParty",
  "Faraday",
  "RestClient",
  ".get",
  ".post",
  ".put",
  ".delete",
  ".patch",
  // File I/O
  "File.read",
  "File.write",
  "File.open",
  "IO.read",
  // Database (ActiveRecord)
  ".find",
  ".where",
  ".all",
  ".first",
  ".last",
  ".create",
  ".update",
  ".save",
  ".destroy",
]);

/** Unbounded query patterns */
const RUBY_UNBOUNDED_PATTERNS = new Set([
  ".all",
  ".where",
  ".find_each",
  ".find_in_batches",
  ".pluck",
  ".select",
]);

/** Pagination patterns */
const RUBY_PAGINATION_PATTERNS = new Set([
  ".limit",
  ".first",
  ".take",
  ".page",
  ".paginate",
  ".per",
  ".offset",
]);

// ============================================================================
// Ruby Analyzer Implementation
// ============================================================================

export class RubyAnalyzer implements LanguageAnalyzer {
  language: SupportedLanguage = "ruby";
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Ruby as unknown as Parser.Language);
  }

  canAnalyze(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith(".rb") || lower.endsWith(".rake") || lower.endsWith(".ru");
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

    // Ruby comment type: comment
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

    // Ruby string types
    const stringTypes = new Set([
      "string",
      "string_content",
      "heredoc_body",
      "heredoc_content",
      "symbol",
      "simple_symbol",
      "delimited_symbol",
    ]);
    const strings = collectNodes(rootNode, stringTypes);
    for (const str of strings) {
      // Skip if parent is also a string (avoid duplicates)
      if (str.parent && stringTypes.has(str.parent.type)) {
        continue;
      }
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

    // Skip test/spec files for some rules
    const isTestFile = filePath.includes("_spec.rb") || filePath.includes("_test.rb") || filePath.includes("/spec/");

    let tree: Parser.Tree;
    try {
      tree = this.parser.parse(content);
    } catch (error) {
      return {
        filePath,
        language: "ruby",
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
    this.detectGlobalMutation(rootNode, content, findings, changedLines);
    if (!isTestFile) {
      this.detectSilentErrors(rootNode, content, findings, changedLines);
    }

    return {
      filePath,
      language: "ruby",
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

  private isInsideMethod(node: Parser.SyntaxNode): boolean {
    return this.findAncestor(node, ["method", "singleton_method"]) !== null;
  }

  private isInsideLoop(node: Parser.SyntaxNode): boolean {
    return this.findAncestor(node, ["for", "while", "until", "call"]) !== null &&
      this.hasIteratorMethod(node);
  }

  private hasIteratorMethod(node: Parser.SyntaxNode): boolean {
    const ancestor = this.findAncestor(node, ["call"]);
    if (!ancestor) return false;

    // Check if parent is an iterator method
    for (const child of ancestor.children) {
      if (child.type === "identifier") {
        const methodName = child.text;
        if (["each", "map", "collect", "select", "reject", "each_with_index", "times"].includes(methodName)) {
          return true;
        }
      }
    }
    return false;
  }

  private isInsideBeginRescue(node: Parser.SyntaxNode): boolean {
    return this.findAncestor(node, ["begin", "rescue"]) !== null;
  }

  private isAtModuleScope(node: Parser.SyntaxNode): boolean {
    return !this.isInsideMethod(node);
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
      isInTryCatch: this.isInsideBeginRescue(node),
      isInLoop: this.isInsideLoop(node),
      isInAsyncFunction: false,
      isModuleScope: this.isAtModuleScope(node),
      isInRouteHandler: this.isInsideController(node, content),
      parentFunctionName: this.getParentMethodName(node, content),
    };
  }

  private isInsideController(node: Parser.SyntaxNode, content: string): boolean {
    const classDecl = this.findAncestor(node, ["class"]);
    if (!classDecl) return false;

    const classText = this.getNodeText(classDecl, content);
    return classText.includes("Controller") || classText.includes("< ApplicationController");
  }

  private getParentMethodName(node: Parser.SyntaxNode, content: string): string | undefined {
    const method = this.findAncestor(node, ["method", "singleton_method"]);
    if (!method) return undefined;

    for (const child of method.children) {
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
   * UNSAFE_IO: I/O calls without begin/rescue
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
      if (!this.isRubyIOCall(callText)) continue;

      const context = this.getCodeContext(call, content);

      // Skip if inside begin/rescue
      if (context.isInTryCatch) continue;

      // Skip if inside loop (LOOPED_IO will catch it)
      if (context.isInLoop) continue;

      findings.push({
        ruleId: "UNSAFE_IO" as RuleId,
        line,
        severity: "high",
        message: "I/O operation without begin/rescue error handling. Network and file operations should rescue exceptions.",
        snippet: callText.slice(0, 100),
        context,
        confidence: "high",
      });
    }
  }

  /**
   * LOOPED_IO: I/O inside loops (N+1 queries)
   */
  private detectLoopedIO(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    // Find .each, .map, etc. blocks and look for I/O inside
    const calls = this.findAllNodes(root, ["call"]);

    for (const call of calls) {
      const line = this.getLineNumber(call);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getNodeText(call, content);
      if (!this.isRubyIOCall(callText)) continue;

      // Check if this is inside an iterator
      const parent = call.parent;
      let isInIterator = false;

      // Walk up to find if we're in a block that's part of an iterator
      let current = call.parent;
      while (current) {
        if (current.type === "block" || current.type === "do_block") {
          const blockParent = current.parent;
          if (blockParent && blockParent.type === "call") {
            const blockParentText = this.getNodeText(blockParent, content);
            if (
              blockParentText.includes(".each") ||
              blockParentText.includes(".map") ||
              blockParentText.includes(".collect") ||
              blockParentText.includes(".select") ||
              blockParentText.includes(".find_each")
            ) {
              isInIterator = true;
              break;
            }
          }
        }
        current = current.parent;
      }

      if (isInIterator) {
        const context = this.getCodeContext(call, content);

        findings.push({
          ruleId: "LOOPED_IO" as RuleId,
          line,
          severity: "high",
          message:
            "I/O/database operation inside an iterator block. This causes N+1 queries. Use includes(), joins(), or batch operations.",
          snippet: callText.slice(0, 100),
          context,
          confidence: "high",
        });
      }
    }
  }

  /**
   * UNBOUNDED_QUERY: ActiveRecord queries without limit
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
      for (const pattern of RUBY_UNBOUNDED_PATTERNS) {
        if (callText.includes(pattern)) {
          isUnbounded = true;
          break;
        }
      }

      if (!isUnbounded) continue;

      // Check for pagination in the chain
      let hasPagination = false;
      for (const pattern of RUBY_PAGINATION_PATTERNS) {
        if (callText.includes(pattern)) {
          hasPagination = true;
          break;
        }
      }

      if (hasPagination) continue;

      // Also check the statement for method chaining
      const stmt = this.findAncestor(call, ["assignment", "expression_statement"]);
      if (stmt) {
        const stmtText = this.getNodeText(stmt, content);
        for (const pattern of RUBY_PAGINATION_PATTERNS) {
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
        message: "ActiveRecord query without limit/pagination. Add .limit() or use pagination to prevent loading unbounded data.",
        snippet: callText.slice(0, 100),
        context,
        confidence: "high",
      });
    }
  }

  /**
   * GLOBAL_MUTATION: Class-level mutable state
   */
  private detectGlobalMutation(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    // Find class variables (@@) and module-level instance variables
    const assignments = this.findAllNodes(root, ["assignment"]);

    for (const assignment of assignments) {
      const line = this.getLineNumber(assignment);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const assignText = this.getNodeText(assignment, content);

      // Check for class variables (@@var) or constants with mutable values
      if (assignText.includes("@@")) {
        const context = this.getCodeContext(assignment, content);

        findings.push({
          ruleId: "GLOBAL_MUTATION" as RuleId,
          line,
          severity: "high",
          message:
            "Class variable (@@) detected. Class variables are shared across all instances and threads, causing race conditions.",
          snippet: assignText.slice(0, 100),
          context,
          confidence: "high",
        });
      }

      // Check for module-level mutable state
      if (!this.isInsideMethod(assignment)) {
        if (assignText.includes("= []") || assignText.includes("= {}") || assignText.includes("= Hash.new")) {
          const context = this.getCodeContext(assignment, content);

          findings.push({
            ruleId: "GLOBAL_MUTATION" as RuleId,
            line,
            severity: "medium",
            message:
              "Module-level mutable data structure. Consider using frozen constants or instance variables.",
            snippet: assignText.slice(0, 100),
            context,
            confidence: "medium",
          });
        }
      }
    }
  }

  /**
   * SILENT_ERROR: Empty rescue blocks
   */
  private detectSilentErrors(
    root: Parser.SyntaxNode,
    content: string,
    findings: ASTFinding[],
    changedLines?: Set<number>
  ): void {
    const rescues = this.findAllNodes(root, ["rescue"]);

    for (const rescue of rescues) {
      const line = this.getLineNumber(rescue);
      if (!this.shouldReportLine(line, changedLines)) continue;

      const rescueText = this.getNodeText(rescue, content);

      // Check if the rescue block is empty or just has nil/return nil
      const bodyMatch = rescueText.match(/rescue[^]*?(?:end|$)/);
      if (bodyMatch) {
        const body = bodyMatch[0];
        // Check if it's essentially empty
        if (
          body.match(/rescue\s*(=>)?\s*\w*\s*nil\s*end/i) ||
          body.match(/rescue\s*(=>)?\s*\w*\s*end/i) ||
          body.match(/rescue\s*(=>)?\s*\w*\s*#[^\n]*\s*end/i)
        ) {
          const context = this.getCodeContext(rescue, content);

          findings.push({
            ruleId: "SILENT_ERROR" as RuleId,
            line,
            severity: "high",
            message: "Empty or swallowed rescue block. Exceptions are being silently ignored.",
            snippet: rescueText.slice(0, 100),
            context,
            confidence: "high",
          });
        }
      }
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private isRubyIOCall(callText: string): boolean {
    for (const pattern of RUBY_IO_PATTERNS) {
      if (callText.includes(pattern)) return true;
    }

    // Check for HTTP client calls
    if (callText.match(/\.(get|post|put|patch|delete)\s*[\(\{]/)) return true;

    // Check for ActiveRecord calls
    if (callText.match(/\.(find|where|all|first|last|create|update|save|destroy)\s*[\(\{]?/)) return true;

    return false;
  }
}

/**
 * Create and export a singleton instance.
 */
export const rubyAnalyzer = new RubyAnalyzer();
