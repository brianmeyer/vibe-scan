/**
 * TypeScript/JavaScript AST analyzer using ts-morph.
 *
 * This analyzer provides high-accuracy detection for rules that benefit from
 * structural analysis: scope detection, control flow, type information.
 *
 * Handles: .ts, .tsx, .js, .jsx, .mjs, .cjs
 */

import {
  Project,
  SourceFile,
  Node,
  SyntaxKind,
  CallExpression,
  VariableDeclaration,
  VariableDeclarationKind,
  CatchClause,
  ForStatement,
  ForOfStatement,
  ForInStatement,
  WhileStatement,
  DoStatement,
  FunctionDeclaration,
  ArrowFunction,
  FunctionExpression,
  MethodDeclaration,
  PropertyAccessExpression,
  ts,
} from "ts-morph";

import {
  LanguageAnalyzer,
  ASTAnalysisResult,
  ASTFinding,
  CodeContext,
  SupportedLanguage,
  ASTAnalysisOptions,
} from "./types";
import { RuleId } from "../rules";
import { Severity } from "../analyzer";

// ============================================================================
// Pattern Constants for AST Analysis
// ============================================================================

/** I/O call patterns - methods that perform network/db/fs operations */
const IO_CALL_PATTERNS = new Set([
  // Fetch API
  "fetch",
  // Axios
  "axios",
  "axios.get",
  "axios.post",
  "axios.put",
  "axios.delete",
  "axios.patch",
  "axios.request",
  // Node http/https
  "http.get",
  "http.request",
  "https.get",
  "https.request",
  // File system
  "fs.readFile",
  "fs.writeFile",
  "fs.appendFile",
  "fs.readFileSync",
  "fs.writeFileSync",
  "fs.appendFileSync",
  "fs.unlink",
  "fs.mkdir",
  "fs.readdir",
  "readFile",
  "writeFile",
  "readFileSync",
  "writeFileSync",
  // Prisma
  "prisma.user.findMany",
  "prisma.user.findFirst",
  "prisma.user.findUnique",
  "prisma.user.create",
  "prisma.user.update",
  "prisma.user.delete",
  // Generic database patterns (partial matches)
  "query",
  "execute",
  "findMany",
  "findAll",
  "findOne",
  "findFirst",
  "findUnique",
  "create",
  "insert",
  "update",
  "delete",
  "save",
  // MongoDB/Mongoose
  "find",
  "aggregate",
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
]);

/** Database query patterns that should have limits */
const UNBOUNDED_QUERY_PATTERNS = new Set([
  "findMany",
  "findAll",
  "find",
  "aggregate",
  "query",
  "select",
  "getAll",
  "list",
  "fetch",
]);

/** Pagination/limit method names */
const PAGINATION_METHODS = new Set(["limit", "take", "skip", "offset", "slice", "page", "paginate", "first", "top"]);

/** File write patterns for SHARED_FILE_WRITE */
const FILE_WRITE_PATTERNS = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "fs.writeFile",
  "fs.writeFileSync",
  "fs.appendFile",
  "fs.appendFileSync",
]);

/** Blocking sync patterns */
const BLOCKING_PATTERNS = new Set([
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "existsSync",
  "mkdirSync",
  "readdirSync",
  "statSync",
  "unlinkSync",
  "copyFileSync",
  "execSync",
  "spawnSync",
  "execFileSync",
]);

// ============================================================================
// TypeScript/JavaScript Analyzer Implementation
// ============================================================================

export class TypeScriptAnalyzer implements LanguageAnalyzer {
  language: SupportedLanguage = "typescript";
  private project: Project;

  constructor() {
    // Create an in-memory project for parsing
    this.project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
    });
  }

  canAnalyze(filePath: string): boolean {
    const ext = filePath.toLowerCase().split(".").pop();
    return ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext || "");
  }

  analyze(content: string, filePath: string, changedLines?: Set<number>): ASTAnalysisResult {
    const startTime = Date.now();
    const findings: ASTFinding[] = [];

    // Try to parse the file
    let sourceFile: SourceFile;
    try {
      // Remove any existing file with this path and create fresh
      const existing = this.project.getSourceFile(filePath);
      if (existing) {
        this.project.removeSourceFile(existing);
      }
      sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
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

    // Run all detection rules
    this.detectUnsafeIO(sourceFile, findings, changedLines);
    this.detectLoopedIO(sourceFile, findings, changedLines);
    this.detectUnboundedQueries(sourceFile, findings, changedLines);
    this.detectGlobalMutation(sourceFile, findings, changedLines);
    this.detectSilentErrors(sourceFile, findings, changedLines);
    this.detectCheckThenAct(sourceFile, findings, changedLines);
    this.detectBlockingOperations(sourceFile, findings, changedLines);
    this.detectSharedFileWrite(sourceFile, findings, changedLines);
    this.detectAsyncMisuse(sourceFile, findings, changedLines);

    // Clean up
    this.project.removeSourceFile(sourceFile);

    return {
      filePath,
      language: this.language,
      parseSuccess: true,
      findings,
      analysisTimeMs: Date.now() - startTime,
    };
  }

  // ==========================================================================
  // Context Detection Helpers
  // ==========================================================================

  private getCodeContext(node: Node): CodeContext {
    return {
      isInTryCatch: this.isInsideTryCatch(node),
      isInLoop: this.isInsideLoop(node),
      isInAsyncFunction: this.isInsideAsyncFunction(node),
      isModuleScope: this.isAtModuleScope(node),
      isInRouteHandler: this.isInsideRouteHandler(node),
      parentFunctionName: this.getParentFunctionName(node),
      enclosingClassName: this.getEnclosingClassName(node),
    };
  }

  private isInsideTryCatch(node: Node): boolean {
    let current: Node | undefined = node;
    while (current) {
      if (Node.isTryStatement(current)) {
        // Check if the node is in the try block (not the catch or finally)
        const tryBlock = current.getTryBlock();
        if (tryBlock && this.isDescendantOf(node, tryBlock)) {
          return true;
        }
      }
      current = current.getParent();
    }
    return false;
  }

  private isInsideLoop(node: Node): boolean {
    let current: Node | undefined = node;
    while (current) {
      if (
        Node.isForStatement(current) ||
        Node.isForOfStatement(current) ||
        Node.isForInStatement(current) ||
        Node.isWhileStatement(current) ||
        Node.isDoStatement(current)
      ) {
        return true;
      }
      // Check for array methods that iterate
      if (Node.isCallExpression(current)) {
        const expr = current.getExpression();
        if (Node.isPropertyAccessExpression(expr)) {
          const methodName = expr.getName();
          if (["forEach", "map", "filter", "reduce", "every", "some", "flatMap"].includes(methodName)) {
            return true;
          }
        }
      }
      current = current.getParent();
    }
    return false;
  }

  private isInsideAsyncFunction(node: Node): boolean {
    let current: Node | undefined = node;
    while (current) {
      if (
        Node.isFunctionDeclaration(current) ||
        Node.isFunctionExpression(current) ||
        Node.isArrowFunction(current) ||
        Node.isMethodDeclaration(current)
      ) {
        // Check if the function has async modifier
        if ("isAsync" in current && typeof current.isAsync === "function") {
          return (current as FunctionDeclaration | ArrowFunction | FunctionExpression | MethodDeclaration).isAsync();
        }
      }
      current = current.getParent();
    }
    return false;
  }

  private isAtModuleScope(node: Node): boolean {
    let current: Node | undefined = node.getParent();
    while (current) {
      if (
        Node.isFunctionDeclaration(current) ||
        Node.isFunctionExpression(current) ||
        Node.isArrowFunction(current) ||
        Node.isMethodDeclaration(current) ||
        Node.isClassDeclaration(current)
      ) {
        return false;
      }
      current = current.getParent();
    }
    return true;
  }

  private isInsideRouteHandler(node: Node): boolean {
    let current: Node | undefined = node;
    while (current) {
      if (Node.isCallExpression(current)) {
        const expr = current.getExpression();
        if (Node.isPropertyAccessExpression(expr)) {
          const methodName = expr.getName();
          const objText = expr.getExpression().getText();
          // Express patterns: app.get(), router.post(), etc.
          if (
            ["get", "post", "put", "patch", "delete", "all", "use"].includes(methodName) &&
            ["app", "router", "express", "server"].some((obj) => objText.includes(obj))
          ) {
            return true;
          }
        }
      }
      current = current.getParent();
    }
    return false;
  }

  private getParentFunctionName(node: Node): string | undefined {
    let current: Node | undefined = node;
    while (current) {
      if (Node.isFunctionDeclaration(current)) {
        return current.getName();
      }
      if (Node.isMethodDeclaration(current)) {
        return current.getName();
      }
      if (Node.isVariableDeclaration(current)) {
        const initializer = current.getInitializer();
        if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
          return current.getName();
        }
      }
      current = current.getParent();
    }
    return undefined;
  }

  private getEnclosingClassName(node: Node): string | undefined {
    let current: Node | undefined = node;
    while (current) {
      if (Node.isClassDeclaration(current)) {
        return current.getName();
      }
      current = current.getParent();
    }
    return undefined;
  }

  private isDescendantOf(node: Node, ancestor: Node): boolean {
    let current: Node | undefined = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.getParent();
    }
    return false;
  }

  private shouldReportLine(line: number, changedLines?: Set<number>): boolean {
    if (!changedLines) return true;
    return changedLines.has(line);
  }

  // ==========================================================================
  // Detection Rules
  // ==========================================================================

  /**
   * UNSAFE_IO: I/O calls without error handling (not in try/catch)
   */
  private detectUnsafeIO(sourceFile: SourceFile, findings: ASTFinding[], changedLines?: Set<number>): void {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callExpressions) {
      const line = call.getStartLineNumber();
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getCallExpressionName(call);
      if (!this.isIOCall(callText)) continue;

      const context = this.getCodeContext(call);

      // Skip if already inside try/catch
      if (context.isInTryCatch) continue;

      // Skip if inside loop (will be caught by LOOPED_IO)
      if (context.isInLoop) continue;

      // Check for .catch() chained
      const parent = call.getParent();
      if (parent && Node.isPropertyAccessExpression(parent)) {
        const grandparent = parent.getParent();
        if (grandparent && Node.isCallExpression(grandparent)) {
          const chainedMethod = parent.getName();
          if (chainedMethod === "catch") continue;
        }
      }

      // Check if the call is awaited and there's a .catch somewhere in the chain
      if (this.hasChainedCatch(call)) continue;

      findings.push({
        ruleId: "UNSAFE_IO" as RuleId,
        line,
        severity: "high",
        message:
          "I/O operation without error handling. This call is not inside a try/catch block and has no .catch() handler.",
        snippet: call.getText().slice(0, 100),
        context,
        confidence: "high",
      });
    }
  }

  /**
   * LOOPED_IO: I/O calls inside loops (N+1 query problem, etc.)
   */
  private detectLoopedIO(sourceFile: SourceFile, findings: ASTFinding[], changedLines?: Set<number>): void {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callExpressions) {
      const line = call.getStartLineNumber();
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getCallExpressionName(call);
      if (!this.isIOCall(callText)) continue;

      const context = this.getCodeContext(call);

      if (context.isInLoop) {
        findings.push({
          ruleId: "LOOPED_IO" as RuleId,
          line,
          severity: "high",
          message:
            "I/O operation inside a loop. This causes N+1 query problems and will not scale. Consider batching or using Promise.all().",
          snippet: call.getText().slice(0, 100),
          context,
          confidence: "high",
        });
      }
    }
  }

  /**
   * UNBOUNDED_QUERY: Database queries without LIMIT/pagination
   */
  private detectUnboundedQueries(sourceFile: SourceFile, findings: ASTFinding[], changedLines?: Set<number>): void {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callExpressions) {
      const line = call.getStartLineNumber();
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getCallExpressionName(call);
      const methodName = callText.split(".").pop() || "";

      if (!UNBOUNDED_QUERY_PATTERNS.has(methodName)) continue;

      // Check if there's a pagination method in the chain
      if (this.hasChainedPagination(call)) continue;

      // Check if limit is passed as an option argument
      if (this.hasLimitInArguments(call)) continue;

      const context = this.getCodeContext(call);

      findings.push({
        ruleId: "UNBOUNDED_QUERY" as RuleId,
        line,
        severity: "high",
        message:
          "Database query without pagination or limit. This will break or slow down at scale. Add .limit(), .take(), or pagination.",
        snippet: call.getText().slice(0, 100),
        context,
        confidence: "high",
      });
    }
  }

  /**
   * GLOBAL_MUTATION: Module-scope mutable variables that are mutated
   */
  private detectGlobalMutation(sourceFile: SourceFile, findings: ASTFinding[], changedLines?: Set<number>): void {
    const variableStatements = sourceFile.getVariableStatements();

    for (const statement of variableStatements) {
      // Only check module-scope declarations
      if (!this.isAtModuleScope(statement)) continue;

      const declarations = statement.getDeclarations();
      const declKind = statement.getDeclarationKind();

      for (const decl of declarations) {
        const line = decl.getStartLineNumber();
        if (!this.shouldReportLine(line, changedLines)) continue;

        const varName = decl.getName();
        const isConst = declKind === VariableDeclarationKind.Const;
        const isLetOrVar = declKind === VariableDeclarationKind.Let || declKind === VariableDeclarationKind.Var;
        const initializer = decl.getInitializer();

        // For const, only flag if it's an object/array that could be mutated
        if (isConst) {
          if (!initializer) continue;
          if (!Node.isArrayLiteralExpression(initializer) && !Node.isObjectLiteralExpression(initializer)) continue;
        }

        // Check if this variable is mutated anywhere in the file
        const isMutated = this.isVariableMutated(sourceFile, varName, isLetOrVar);

        if (isMutated) {
          const context = this.getCodeContext(decl);

          findings.push({
            ruleId: "GLOBAL_MUTATION" as RuleId,
            line,
            severity: "high",
            message: `Module-scope mutable state '${varName}' is modified. This can cause concurrency bugs and cross-request contamination in servers.`,
            snippet: statement.getText().slice(0, 100),
            context,
            confidence: "high",
          });
        }
      }
    }
  }

  /**
   * SILENT_ERROR: Catch blocks that don't properly handle errors
   */
  private detectSilentErrors(sourceFile: SourceFile, findings: ASTFinding[], changedLines?: Set<number>): void {
    const catchClauses = sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause);

    for (const catchClause of catchClauses) {
      const line = catchClause.getStartLineNumber();
      if (!this.shouldReportLine(line, changedLines)) continue;

      const block = catchClause.getBlock();
      const statements = block.getStatements();

      // Check if the catch block is effectively silent
      if (this.isSilentCatchBlock(statements)) {
        const context = this.getCodeContext(catchClause);

        findings.push({
          ruleId: "SILENT_ERROR" as RuleId,
          line,
          severity: "high",
          message:
            "Catch block swallows errors silently. Errors are either ignored or only logged without being re-thrown or properly handled.",
          snippet: catchClause.getText().slice(0, 100),
          context,
          confidence: "high",
        });
      }
    }

    // Also check for .catch() that are silent
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of callExpressions) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      if (expr.getName() !== "catch") continue;

      const line = call.getStartLineNumber();
      if (!this.shouldReportLine(line, changedLines)) continue;

      const args = call.getArguments();
      if (args.length === 0) continue;

      const handler = args[0];
      if (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) {
        const body = handler.getBody();
        if (Node.isBlock(body)) {
          const statements = body.getStatements();
          if (this.isSilentCatchBlock(statements)) {
            const context = this.getCodeContext(call);

            findings.push({
              ruleId: "SILENT_ERROR" as RuleId,
              line,
              severity: "high",
              message:
                ".catch() handler swallows errors silently. Consider re-throwing or properly handling the error.",
              snippet: call.getText().slice(0, 100),
              context,
              confidence: "high",
            });
          }
        }
      }
    }
  }

  /**
   * CHECK_THEN_ACT_RACE: Find-then-create patterns that can race
   */
  private detectCheckThenAct(sourceFile: SourceFile, findings: ASTFinding[], changedLines?: Set<number>): void {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    const checkMethods = ["findOne", "findUnique", "findFirst", "get", "getOne", "exists", "find"];
    const actMethods = ["create", "insert", "insertOne", "save", "add"];

    for (let i = 0; i < callExpressions.length; i++) {
      const checkCall = callExpressions[i];
      const checkMethod = this.getCallExpressionName(checkCall).split(".").pop() || "";

      if (!checkMethods.includes(checkMethod)) continue;

      const line = checkCall.getStartLineNumber();
      if (!this.shouldReportLine(line, changedLines)) continue;

      // Look for an act method within the next few statements
      const parentBlock = checkCall.getFirstAncestorByKind(SyntaxKind.Block);
      if (!parentBlock) continue;

      const checkStatement = checkCall.getFirstAncestorByKind(SyntaxKind.ExpressionStatement)
        || checkCall.getFirstAncestorByKind(SyntaxKind.VariableStatement);
      if (!checkStatement) continue;

      const blockStatements = parentBlock.getStatements();
      const checkIndex = blockStatements.findIndex((s) => s === checkStatement);
      if (checkIndex === -1) continue;

      // Check the next few statements for an act pattern
      for (let j = checkIndex + 1; j < Math.min(checkIndex + 5, blockStatements.length); j++) {
        const nextStatement = blockStatements[j];
        const actCalls = nextStatement.getDescendantsOfKind(SyntaxKind.CallExpression);

        for (const actCall of actCalls) {
          const actMethod = this.getCallExpressionName(actCall).split(".").pop() || "";
          if (actMethods.includes(actMethod)) {
            const context = this.getCodeContext(checkCall);

            findings.push({
              ruleId: "CHECK_THEN_ACT_RACE" as RuleId,
              line,
              severity: "medium",
              message:
                "Find-then-create pattern detected. This can race under concurrent requests. Consider using upsert or database-level constraints.",
              snippet: checkCall.getText().slice(0, 60) + " ... " + actCall.getText().slice(0, 40),
              context,
              confidence: "high",
            });
            break;
          }
        }
      }
    }
  }

  /**
   * BLOCKING_OPERATION: Synchronous blocking operations
   */
  private detectBlockingOperations(sourceFile: SourceFile, findings: ASTFinding[], changedLines?: Set<number>): void {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callExpressions) {
      const line = call.getStartLineNumber();
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getCallExpressionName(call);
      const methodName = callText.split(".").pop() || "";

      if (BLOCKING_PATTERNS.has(methodName) || BLOCKING_PATTERNS.has(callText)) {
        const context = this.getCodeContext(call);

        findings.push({
          ruleId: "BLOCKING_OPERATION" as RuleId,
          line,
          severity: "medium",
          message:
            "Synchronous blocking operation detected. This blocks the event loop and degrades performance under load. Use async alternatives.",
          snippet: call.getText().slice(0, 100),
          context,
          confidence: "high",
        });
      }
    }
  }

  /**
   * SHARED_FILE_WRITE: Writing to hardcoded file paths
   */
  private detectSharedFileWrite(sourceFile: SourceFile, findings: ASTFinding[], changedLines?: Set<number>): void {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callExpressions) {
      const line = call.getStartLineNumber();
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getCallExpressionName(call);
      const methodName = callText.split(".").pop() || "";

      if (!FILE_WRITE_PATTERNS.has(methodName) && !FILE_WRITE_PATTERNS.has(callText)) continue;

      // Check if the first argument is a string literal (hardcoded path)
      const args = call.getArguments();
      if (args.length === 0) continue;

      const firstArg = args[0];
      if (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg)) {
        const context = this.getCodeContext(call);

        findings.push({
          ruleId: "SHARED_FILE_WRITE" as RuleId,
          line,
          severity: "high",
          message:
            "Writing to a hardcoded file path. Multiple concurrent requests can cause race conditions and data corruption.",
          snippet: call.getText().slice(0, 100),
          context,
          confidence: "high",
        });
      }
    }
  }

  /**
   * ASYNC_MISUSE: Missing await, fire-and-forget async calls
   */
  private detectAsyncMisuse(sourceFile: SourceFile, findings: ASTFinding[], changedLines?: Set<number>): void {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callExpressions) {
      const line = call.getStartLineNumber();
      if (!this.shouldReportLine(line, changedLines)) continue;

      const callText = this.getCallExpressionName(call);
      if (!this.isIOCall(callText)) continue;

      const context = this.getCodeContext(call);

      // Only check inside async functions
      if (!context.isInAsyncFunction) continue;

      // Check if the call is awaited
      const parent = call.getParent();
      if (parent && Node.isAwaitExpression(parent)) continue;

      // Check if it's returned
      const returnParent = call.getFirstAncestorByKind(SyntaxKind.ReturnStatement);
      if (returnParent) continue;

      // Check if it's assigned or has .then()/.catch()
      if (this.hasChainedCatch(call)) continue;
      if (this.hasChainedThen(call)) continue;

      // Check if assigned to a variable (will be used later)
      const varDecl = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      if (varDecl) continue;

      findings.push({
        ruleId: "ASYNC_MISUSE" as RuleId,
        line,
        severity: "medium",
        message:
          "Async operation without await in async function. This may be fire-and-forget, causing missed errors or race conditions.",
        snippet: call.getText().slice(0, 100),
        context,
        confidence: "medium",
      });
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private getCallExpressionName(call: CallExpression): string {
    const expr = call.getExpression();

    if (Node.isIdentifier(expr)) {
      return expr.getText();
    }

    if (Node.isPropertyAccessExpression(expr)) {
      return expr.getText();
    }

    return expr.getText();
  }

  private isIOCall(callText: string): boolean {
    // Check exact matches
    if (IO_CALL_PATTERNS.has(callText)) return true;

    // Check if ends with an IO pattern
    const parts = callText.split(".");
    const methodName = parts[parts.length - 1];
    if (IO_CALL_PATTERNS.has(methodName)) return true;

    // Check common patterns
    if (callText.includes("fetch")) return true;
    if (callText.includes("axios")) return true;
    if (callText.includes("prisma.")) return true;
    if (callText.includes("mongoose.")) return true;
    if (callText.includes("redis.")) return true;
    if (callText.includes("db.")) return true;
    if (/fs\.(read|write|append|unlink|mkdir)/.test(callText)) return true;

    return false;
  }

  private hasChainedCatch(call: CallExpression): boolean {
    // Walk up to find the root of the call chain
    let root: Node = call;
    while (true) {
      const parent = root.getParent();
      if (!parent) break;

      // Keep walking up through property access and call expressions
      if (Node.isPropertyAccessExpression(parent)) {
        root = parent;
        continue;
      }
      if (Node.isCallExpression(parent)) {
        root = parent;
        continue;
      }
      if (Node.isAwaitExpression(parent)) {
        root = parent;
        continue;
      }
      break;
    }

    // Now check if .catch() appears anywhere in the chain
    const checkForCatch = (node: Node): boolean => {
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (Node.isPropertyAccessExpression(expr) && expr.getName() === "catch") {
          return true;
        }
        // Recursively check the expression being called
        return checkForCatch(expr);
      }
      if (Node.isPropertyAccessExpression(node)) {
        return checkForCatch(node.getExpression());
      }
      if (Node.isAwaitExpression(node)) {
        return checkForCatch(node.getExpression());
      }
      return false;
    };

    return checkForCatch(root);
  }

  private hasChainedThen(call: CallExpression): boolean {
    let current: Node = call;
    while (current) {
      const parent = current.getParent();
      if (!parent) break;

      if (Node.isPropertyAccessExpression(parent) && parent.getName() === "then") {
        return true;
      }
      if (Node.isCallExpression(parent)) {
        const expr = parent.getExpression();
        if (Node.isPropertyAccessExpression(expr) && expr.getName() === "then") {
          return true;
        }
      }
      current = parent;
    }
    return false;
  }

  private hasChainedPagination(call: CallExpression): boolean {
    let current: Node = call;

    // Walk up to find chained calls
    while (current) {
      const parent = current.getParent();
      if (!parent) break;

      if (Node.isPropertyAccessExpression(parent)) {
        const methodName = parent.getName();
        if (PAGINATION_METHODS.has(methodName)) {
          return true;
        }
      }

      if (Node.isCallExpression(parent)) {
        const expr = parent.getExpression();
        if (Node.isPropertyAccessExpression(expr)) {
          const methodName = expr.getName();
          if (PAGINATION_METHODS.has(methodName)) {
            return true;
          }
        }
        current = parent;
      } else {
        break;
      }
    }

    return false;
  }

  private hasLimitInArguments(call: CallExpression): boolean {
    const args = call.getArguments();
    for (const arg of args) {
      const text = arg.getText().toLowerCase();
      if (text.includes("limit") || text.includes("take") || text.includes("pagesize")) {
        return true;
      }
    }
    return false;
  }

  private isVariableMutated(sourceFile: SourceFile, varName: string, checkReassignment: boolean = false): boolean {
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);

    for (const id of identifiers) {
      if (id.getText() !== varName) continue;

      const parent = id.getParent();
      if (!parent) continue;

      // Check for reassignment: varName = ... (only for let/var)
      if (checkReassignment && Node.isBinaryExpression(parent)) {
        const left = parent.getLeft();
        if (left === id && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
          return true;
        }
      }

      // Check for increment/decrement: varName++ or ++varName
      if (checkReassignment) {
        if (Node.isPostfixUnaryExpression(parent) || Node.isPrefixUnaryExpression(parent)) {
          const opKind = parent.getOperatorToken();
          if (opKind === SyntaxKind.PlusPlusToken || opKind === SyntaxKind.MinusMinusToken) {
            return true;
          }
        }
        // Check for compound assignment: varName += ...
        if (Node.isBinaryExpression(parent)) {
          const left = parent.getLeft();
          const op = parent.getOperatorToken().getKind();
          if (left === id && (
            op === SyntaxKind.PlusEqualsToken ||
            op === SyntaxKind.MinusEqualsToken ||
            op === SyntaxKind.AsteriskEqualsToken ||
            op === SyntaxKind.SlashEqualsToken
          )) {
            return true;
          }
        }
      }

      // Check for property access mutation: varName.prop = ... or varName.push(...)
      if (Node.isPropertyAccessExpression(parent)) {
        const objExpr = parent.getExpression();
        if (objExpr === id) {
          const grandparent = parent.getParent();

          // Assignment to property
          if (Node.isBinaryExpression(grandparent)) {
            if (grandparent.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
              return true;
            }
          }

          // Mutating method call
          if (Node.isCallExpression(grandparent)) {
            const methodName = parent.getName();
            if (["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill"].includes(methodName)) {
              return true;
            }
          }
        }
      }

      // Check for index assignment: varName[x] = ...
      if (Node.isElementAccessExpression(parent)) {
        const objExpr = parent.getExpression();
        if (objExpr === id) {
          const grandparent = parent.getParent();
          if (Node.isBinaryExpression(grandparent)) {
            if (grandparent.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  private isSilentCatchBlock(statements: Node[]): boolean {
    // Empty catch block
    if (statements.length === 0) return true;

    // Check if all statements are just console.log/error/warn
    let hasOnlyLogging = true;
    let hasRethrow = false;
    let hasReturn = false;
    let hasReject = false;

    for (const stmt of statements) {
      const text = stmt.getText();

      if (text.includes("throw")) hasRethrow = true;
      if (text.includes("return")) hasReturn = true;
      if (text.includes("reject")) hasReject = true;

      // If it's not just a console call, it's doing something
      if (!text.match(/^\s*console\.(log|error|warn|info|debug)\s*\(/)) {
        if (!text.match(/^\s*\/\//)) {
          // Not a comment either
          hasOnlyLogging = false;
        }
      }
    }

    // Silent if: only logging without rethrowing/returning/rejecting
    if (hasOnlyLogging && !hasRethrow && !hasReturn && !hasReject) {
      return true;
    }

    return false;
  }
}

/**
 * Create and export a singleton instance for convenience.
 */
export const typescriptAnalyzer = new TypeScriptAnalyzer();
