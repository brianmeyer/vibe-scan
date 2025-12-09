/**
 * Unit tests for AST-based analysis (TypeScript and Python).
 */

import { TypeScriptAnalyzer } from "../src/analysis/ast/typescript";
import { PythonAnalyzer } from "../src/analysis/ast/python";
import {
  analyzeWithAST,
  canAnalyzeWithAST,
  parseChangedLinesFromPatch,
  mergeFindings,
  convertASTFindingsToFindings,
  getIgnoredRanges,
} from "../src/analysis/ast";
import { Finding } from "../src/analysis/analyzer";

describe("TypeScript AST Analyzer", () => {
  const analyzer = new TypeScriptAnalyzer();

  describe("UNSAFE_IO detection", () => {
    it("should detect fetch() not in try/catch", () => {
      const code = `
async function getData() {
  const response = await fetch('/api/data');
  return response.json();
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "UNSAFE_IO")).toBe(true);
      const finding = result.findings.find((f) => f.ruleId === "UNSAFE_IO");
      expect(finding?.confidence).toBe("high");
      expect(finding?.context.isInTryCatch).toBe(false);
    });

    it("should NOT flag fetch() inside try/catch", () => {
      const code = `
async function getData() {
  try {
    const response = await fetch('/api/data');
    return response.json();
  } catch (error) {
    console.error(error);
    throw error;
  }
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "UNSAFE_IO")).toBe(false);
    });

    it("should NOT flag fetch() with .catch() chain", () => {
      const code = `
async function getData() {
  const response = await fetch('/api/data')
    .then(r => r.json())
    .catch(err => null);
  return response;
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "UNSAFE_IO")).toBe(false);
    });
  });

  describe("LOOPED_IO detection", () => {
    it("should detect I/O inside for...of loop", () => {
      const code = `
async function fetchAll(ids: string[]) {
  for (const id of ids) {
    const data = await fetch(\`/api/items/\${id}\`);
    console.log(data);
  }
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "LOOPED_IO")).toBe(true);
      const finding = result.findings.find((f) => f.ruleId === "LOOPED_IO");
      expect(finding?.context.isInLoop).toBe(true);
    });

    it("should detect I/O inside forEach", () => {
      const code = `
async function updateAll(users: User[]) {
  users.forEach(async (user) => {
    await prisma.user.update({ where: { id: user.id }, data: user });
  });
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "LOOPED_IO")).toBe(true);
    });

    it("should detect I/O inside map", () => {
      const code = `
async function fetchUsers(ids: string[]) {
  return ids.map(async (id) => {
    return await axios.get(\`/users/\${id}\`);
  });
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "LOOPED_IO")).toBe(true);
    });
  });

  describe("UNBOUNDED_QUERY detection", () => {
    it("should detect findMany() without limit", () => {
      const code = `
async function getUsers() {
  const users = await prisma.user.findMany();
  return users;
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "UNBOUNDED_QUERY")).toBe(true);
    });

    it("should NOT flag findMany() with take()", () => {
      const code = `
async function getUsers() {
  const users = await prisma.user.findMany().take(10);
  return users;
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "UNBOUNDED_QUERY")).toBe(false);
    });

    it("should NOT flag findMany() with limit option", () => {
      const code = `
async function getUsers() {
  const users = await prisma.user.findMany({ limit: 100 });
  return users;
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "UNBOUNDED_QUERY")).toBe(false);
    });
  });

  describe("GLOBAL_MUTATION detection", () => {
    it("should detect module-level mutable state", () => {
      const code = `
const cache: Record<string, any> = {};

function setCache(key: string, value: any) {
  cache[key] = value;
}

function getCache(key: string) {
  return cache[key];
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "GLOBAL_MUTATION")).toBe(true);
      const finding = result.findings.find((f) => f.ruleId === "GLOBAL_MUTATION");
      expect(finding?.context.isModuleScope).toBe(true);
    });

    it("should detect let variable mutation", () => {
      const code = `
let requestCount = 0;

function handleRequest() {
  requestCount++;
  return requestCount;
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "GLOBAL_MUTATION")).toBe(true);
    });

    it("should detect array push on module-level const", () => {
      const code = `
const items: string[] = [];

function addItem(item: string) {
  items.push(item);
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "GLOBAL_MUTATION")).toBe(true);
    });
  });

  describe("SILENT_ERROR detection", () => {
    it("should detect empty catch block", () => {
      const code = `
async function getData() {
  try {
    return await fetch('/api');
  } catch (err) {
  }
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "SILENT_ERROR")).toBe(true);
    });

    it("should detect catch with only console.log", () => {
      const code = `
async function getData() {
  try {
    return await fetch('/api');
  } catch (err) {
    console.log(err);
  }
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "SILENT_ERROR")).toBe(true);
    });

    it("should NOT flag catch that rethrows", () => {
      const code = `
async function getData() {
  try {
    return await fetch('/api');
  } catch (err) {
    console.error(err);
    throw err;
  }
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "SILENT_ERROR")).toBe(false);
    });
  });

  describe("BLOCKING_OPERATION detection", () => {
    it("should detect readFileSync", () => {
      const code = `
function loadConfig() {
  const data = fs.readFileSync('./config.json');
  return JSON.parse(data.toString());
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "BLOCKING_OPERATION")).toBe(true);
    });

    it("should detect execSync", () => {
      const code = `
function runCommand(cmd: string) {
  return execSync(cmd).toString();
}
`;
      const result = analyzer.analyze(code, "test.ts");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "BLOCKING_OPERATION")).toBe(true);
    });
  });

  describe("Changed lines filtering", () => {
    it("should only report findings on changed lines", () => {
      // Line numbers: 1=empty, 2=oldFunction, 3=fetch old, 4=}, 5=empty, 6=newFunction, 7=fetch new, 8=}
      const code = `
async function oldFunction() {
  await fetch('/old');
}

async function newFunction() {
  await fetch('/new');
}
`;
      // Only line 7 (fetch new) changed
      const changedLines = new Set([7]);
      const result = analyzer.analyze(code, "test.ts", changedLines);

      expect(result.parseSuccess).toBe(true);
      const findings = result.findings.filter((f) => f.ruleId === "UNSAFE_IO");
      expect(findings.length).toBe(1);
      expect(findings[0].line).toBe(7);
    });
  });
});

describe("Python AST Analyzer", () => {
  const analyzer = new PythonAnalyzer();

  describe("UNSAFE_IO detection", () => {
    it("should detect requests.get() not in try/except", () => {
      const code = `
def fetch_data(url):
    response = requests.get(url)
    return response.json()
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "UNSAFE_IO")).toBe(true);
    });

    it("should NOT flag requests.get() inside try/except", () => {
      const code = `
def fetch_data(url):
    try:
        response = requests.get(url)
        return response.json()
    except Exception as e:
        print(e)
        raise
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "UNSAFE_IO")).toBe(false);
    });
  });

  describe("LOOPED_IO detection", () => {
    it("should detect I/O inside for loop", () => {
      const code = `
def fetch_all(urls):
    results = []
    for url in urls:
        response = requests.get(url)
        results.append(response.json())
    return results
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "LOOPED_IO")).toBe(true);
    });

    it("should detect I/O inside list comprehension", () => {
      const code = `
def fetch_all(urls):
    return [requests.get(url).json() for url in urls]
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "LOOPED_IO")).toBe(true);
    });
  });

  describe("UNBOUNDED_QUERY detection", () => {
    it("should detect objects.all() without limit", () => {
      const code = `
def get_users():
    return User.objects.all()
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "UNBOUNDED_QUERY")).toBe(true);
    });

    it("should NOT flag query with slice", () => {
      const code = `
def get_users():
    return User.objects.all()[:100]
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "UNBOUNDED_QUERY")).toBe(false);
    });
  });

  describe("SILENT_ERROR detection", () => {
    it("should detect except with just pass", () => {
      const code = `
def fetch_data(url):
    try:
        return requests.get(url).json()
    except:
        pass
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "SILENT_ERROR")).toBe(true);
    });

    it("should detect except with only logging", () => {
      const code = `
def fetch_data(url):
    try:
        return requests.get(url).json()
    except Exception as e:
        logging.error(e)
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "SILENT_ERROR")).toBe(true);
    });

    it("should NOT flag except that re-raises", () => {
      const code = `
def fetch_data(url):
    try:
        return requests.get(url).json()
    except Exception as e:
        logging.error(e)
        raise
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "SILENT_ERROR")).toBe(false);
    });
  });

  describe("GLOBAL_MUTATION detection", () => {
    it("should detect module-level mutable state", () => {
      const code = `
cache = {}

def set_cache(key, value):
    cache[key] = value
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "GLOBAL_MUTATION")).toBe(true);
    });

    it("should detect list append on module-level variable", () => {
      const code = `
items = []

def add_item(item):
    items.append(item)
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "GLOBAL_MUTATION")).toBe(true);
    });
  });

  describe("BLOCKING_OPERATION detection", () => {
    it("should detect time.sleep in async function", () => {
      const code = `
async def process_data():
    time.sleep(5)
    return await fetch_data()
`;
      const result = analyzer.analyze(code, "test.py");

      expect(result.parseSuccess).toBe(true);
      expect(result.findings.some((f) => f.ruleId === "BLOCKING_OPERATION")).toBe(true);
    });
  });
});

describe("AST Helper Functions", () => {
  describe("canAnalyzeWithAST", () => {
    it("should return true for TypeScript files", () => {
      expect(canAnalyzeWithAST("src/app.ts")).toBe(true);
      expect(canAnalyzeWithAST("src/App.tsx")).toBe(true);
    });

    it("should return true for JavaScript files", () => {
      expect(canAnalyzeWithAST("src/app.js")).toBe(true);
      expect(canAnalyzeWithAST("src/App.jsx")).toBe(true);
      expect(canAnalyzeWithAST("src/app.mjs")).toBe(true);
    });

    it("should return true for Python files", () => {
      expect(canAnalyzeWithAST("src/app.py")).toBe(true);
    });

    it("should return true for Go files", () => {
      expect(canAnalyzeWithAST("src/app.go")).toBe(true);
    });

    it("should return true for Ruby files", () => {
      expect(canAnalyzeWithAST("src/app.rb")).toBe(true);
      expect(canAnalyzeWithAST("Rakefile.rake")).toBe(true);
    });

    it("should return false for unsupported files", () => {
      expect(canAnalyzeWithAST("README.md")).toBe(false);
      expect(canAnalyzeWithAST("src/app.java")).toBe(false);
      expect(canAnalyzeWithAST("Dockerfile")).toBe(false);
    });
  });

  describe("parseChangedLinesFromPatch", () => {
    it("should parse changed lines from unified diff", () => {
      const patch = `@@ -1,3 +1,5 @@
 import { db } from './db';

+async function getUsers() {
+  const users = await db.users.findMany();
+  return users;
+}`;

      const changedLines = parseChangedLinesFromPatch(patch);

      expect(changedLines.has(3)).toBe(true); // async function
      expect(changedLines.has(4)).toBe(true); // const users
      expect(changedLines.has(5)).toBe(true); // return users
      expect(changedLines.has(6)).toBe(true); // }
      expect(changedLines.has(1)).toBe(false); // context line
    });

    it("should handle multiple hunks", () => {
      const patch = `@@ -1,2 +1,3 @@
+const a = 1;
 existing line
@@ -10,2 +11,3 @@
+const b = 2;
 another existing line`;

      const changedLines = parseChangedLinesFromPatch(patch);

      expect(changedLines.has(1)).toBe(true);
      expect(changedLines.has(11)).toBe(true);
    });
  });

  describe("mergeFindings", () => {
    it("should prefer AST findings for AST-preferred rules", () => {
      const astFindings: Finding[] = [
        {
          file: "test.ts",
          line: 5,
          severity: "high",
          kind: "UNSAFE_IO",
          message: "AST: Found unsafe I/O",
        },
      ];

      const regexFindings: Finding[] = [
        {
          file: "test.ts",
          line: 5,
          severity: "high",
          kind: "UNSAFE_IO",
          message: "Regex: Found unsafe I/O",
        },
        {
          file: "test.ts",
          line: 10,
          severity: "medium",
          kind: "TEMPORARY_HACK",
          message: "TODO comment found",
        },
      ];

      const merged = mergeFindings(astFindings, regexFindings);

      // Should have AST UNSAFE_IO and regex TEMPORARY_HACK
      expect(merged.length).toBe(2);
      expect(merged.find((f) => f.kind === "UNSAFE_IO")?.message).toContain("AST");
      expect(merged.find((f) => f.kind === "TEMPORARY_HACK")).toBeDefined();
    });

    it("should deduplicate by file:line:kind", () => {
      const astFindings: Finding[] = [
        {
          file: "test.ts",
          line: 5,
          severity: "high",
          kind: "LOOPED_IO",
          message: "AST finding",
        },
      ];

      const regexFindings: Finding[] = [
        {
          file: "test.ts",
          line: 5,
          severity: "high",
          kind: "LOOPED_IO",
          message: "Regex finding",
        },
      ];

      const merged = mergeFindings(astFindings, regexFindings);

      expect(merged.length).toBe(1);
    });
  });

  describe("getIgnoredRanges", () => {
    it("should detect TypeScript comments", () => {
      const code = `
// This is a comment
const x = 1; // inline comment
/* multi
   line
   comment */
const y = 2;
`;
      const ranges = getIgnoredRanges(code, "test.ts");
      expect(ranges).not.toBeNull();
      expect(ranges!.filter((r) => r.type === "comment").length).toBeGreaterThanOrEqual(2);
    });

    it("should detect TypeScript string literals", () => {
      const code = `
const msg = "Hello world";
const template = \`Template literal\`;
`;
      const ranges = getIgnoredRanges(code, "test.ts");
      expect(ranges).not.toBeNull();
      expect(ranges!.filter((r) => r.type === "string").length).toBeGreaterThanOrEqual(2);
    });

    it("should detect Python comments", () => {
      const code = `
# This is a comment
x = 1  # inline comment
`;
      const ranges = getIgnoredRanges(code, "test.py");
      expect(ranges).not.toBeNull();
      expect(ranges!.filter((r) => r.type === "comment").length).toBeGreaterThanOrEqual(2);
    });

    it("should detect Python string literals", () => {
      const code = `
msg = "Hello world"
multiline = """
Multi-line
string
"""
`;
      const ranges = getIgnoredRanges(code, "test.py");
      expect(ranges).not.toBeNull();
      expect(ranges!.filter((r) => r.type === "string").length).toBeGreaterThanOrEqual(2);
    });

    it("should return null for unsupported languages", () => {
      const code = `public class Test { }`;
      const ranges = getIgnoredRanges(code, "test.java");
      expect(ranges).toBeNull();
    });
  });
});
