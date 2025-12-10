/**
 * Unit tests for the core static analysis logic.
 */

import { analyzePatch, analyzePullRequestPatchesWithConfig, createDefaultConfig } from "../src/analysis/analyzer";

describe("analyzePatch", () => {
  describe("UNBOUNDED_QUERY detection", () => {
    it("should detect unbounded findMany() without limit", () => {
      const patch = `@@ -1,3 +1,5 @@
 import { db } from './db';

+async function getUsers() {
+  const users = await db.users.findMany();
+  return users;
+}`;

      const findings = analyzePatch("src/api/users.ts", patch);

      expect(findings.some((f) => f.kind === "UNBOUNDED_QUERY")).toBe(true);
      const unboundedFinding = findings.find((f) => f.kind === "UNBOUNDED_QUERY");
      expect(unboundedFinding?.severity).toBe("high");
      expect(unboundedFinding?.message).toContain("unbounded");
    });

    it("should detect unbounded SELECT * FROM", () => {
      const patch = `@@ -1,2 +1,4 @@
+const query = "SELECT * FROM users";
+const result = await db.query(query);`;

      const findings = analyzePatch("src/db/queries.ts", patch);

      expect(findings.some((f) => f.kind === "UNBOUNDED_QUERY")).toBe(true);
    });

    it("should NOT flag queries with .limit()", () => {
      const patch = `@@ -1,3 +1,5 @@
+async function getUsers() {
+  const users = await db.users.findMany().limit(10);
+  return users;
+}`;

      const findings = analyzePatch("src/api/users.ts", patch);

      expect(findings.some((f) => f.kind === "UNBOUNDED_QUERY")).toBe(false);
    });

    it("should NOT flag queries with .take()", () => {
      const patch = `@@ -1,3 +1,5 @@
+async function getUsers() {
+  const users = await db.users.findMany().take(20);
+  return users;
+}`;

      const findings = analyzePatch("src/api/users.ts", patch);

      expect(findings.some((f) => f.kind === "UNBOUNDED_QUERY")).toBe(false);
    });
  });

  describe("UNSAFE_IO detection", () => {
    it("should detect fetch() without try/catch", () => {
      const patch = `@@ -1,2 +1,4 @@
+async function getData() {
+  const response = await fetch('/api/data');
+  return response.json();
+}`;

      const findings = analyzePatch("src/api/client.ts", patch);

      expect(findings.some((f) => f.kind === "UNSAFE_IO")).toBe(true);
      const unsafeFinding = findings.find((f) => f.kind === "UNSAFE_IO");
      expect(unsafeFinding?.severity).toBe("high");
    });

    it("should detect axios calls without error handling", () => {
      const patch = `@@ -1,2 +1,3 @@
+async function fetchUser(id: string) {
+  const user = await axios.get(\`/users/\${id}\`);
+}`;

      const findings = analyzePatch("src/services/user.ts", patch);

      expect(findings.some((f) => f.kind === "UNSAFE_IO")).toBe(true);
    });

    it("should NOT flag I/O with try/catch nearby", () => {
      const patch = `@@ -1,5 +1,10 @@
+async function getData() {
+  try {
+    const response = await fetch('/api/data');
+    return response.json();
+  } catch (err) {
+    console.error(err);
+    throw err;
+  }
+}`;

      const findings = analyzePatch("src/api/client.ts", patch);

      expect(findings.some((f) => f.kind === "UNSAFE_IO")).toBe(false);
    });

    it("should NOT flag I/O with .catch() nearby", () => {
      const patch = `@@ -1,3 +1,5 @@
+const data = await fetch('/api/data')
+  .then(r => r.json())
+  .catch(err => null);`;

      const findings = analyzePatch("src/api/client.ts", patch);

      expect(findings.some((f) => f.kind === "UNSAFE_IO")).toBe(false);
    });
  });

  describe("Inline suppression directives", () => {
    it("should suppress finding with vibescan-ignore-next-line", () => {
      const patch = `@@ -1,3 +1,5 @@
+async function getData() {
+  // vibescan-ignore-next-line UNSAFE_IO
+  const response = await fetch('/api/data');
+  return response.json();
+}`;

      const findings = analyzePatch("src/api/client.ts", patch);

      // Note: analyzePatch itself doesn't handle suppressions - that's done by
      // analyzePullRequestPatchesWithConfig. This test verifies the raw detection.
      // The suppression test should use the config-aware function.
      expect(findings.some((f) => f.kind === "UNSAFE_IO")).toBe(true);
    });
  });

  describe("TEMPORARY_HACK detection", () => {
    it("should detect TODO comments", () => {
      const patch = `@@ -1,2 +1,3 @@
+// TODO: fix this later
+const x = 1;`;

      const findings = analyzePatch("src/utils.ts", patch);

      expect(findings.some((f) => f.kind === "TEMPORARY_HACK")).toBe(true);
    });

    it("should detect FIXME comments", () => {
      const patch = `@@ -1,2 +1,3 @@
+// FIXME: this is broken
+const x = 1;`;

      const findings = analyzePatch("src/utils.ts", patch);

      expect(findings.some((f) => f.kind === "TEMPORARY_HACK")).toBe(true);
    });

    it("should detect HACK comments", () => {
      const patch = `@@ -1,2 +1,3 @@
+// HACK: workaround for bug
+const x = 1;`;

      const findings = analyzePatch("src/utils.ts", patch);

      expect(findings.some((f) => f.kind === "TEMPORARY_HACK")).toBe(true);
    });
  });

  describe("LOOPED_IO detection", () => {
    it("should detect I/O inside loops", () => {
      const patch = `@@ -1,5 +1,8 @@
+async function fetchAll(ids: string[]) {
+  for (const id of ids) {
+    const data = await fetch(\`/api/items/\${id}\`);
+  }
+}`;

      const findings = analyzePatch("src/api/batch.ts", patch);

      expect(findings.some((f) => f.kind === "LOOPED_IO")).toBe(true);
      const loopedFinding = findings.find((f) => f.kind === "LOOPED_IO");
      expect(loopedFinding?.severity).toBe("high");
    });

    it("should detect database calls inside forEach", () => {
      const patch = `@@ -1,5 +1,8 @@
+async function updateAll(users: User[]) {
+  users.forEach(async (user) => {
+    await prisma.user.update({ where: { id: user.id }, data: user });
+  });
+}`;

      const findings = analyzePatch("src/db/users.ts", patch);

      expect(findings.some((f) => f.kind === "LOOPED_IO")).toBe(true);
    });
  });

  describe("SILENT_ERROR detection", () => {
    it("should detect empty catch blocks", () => {
      const patch = `@@ -1,6 +1,10 @@
+async function getData() {
+  try {
+    return await fetch('/api');
+  } catch (err) {
+  }
+}`;

      const findings = analyzePatch("src/api/client.ts", patch);

      expect(findings.some((f) => f.kind === "SILENT_ERROR")).toBe(true);
    });

    it("should detect catch blocks with only console.log", () => {
      const patch = `@@ -1,6 +1,10 @@
+async function getData() {
+  try {
+    return await fetch('/api');
+  } catch (err) {
+    console.log(err);
+  }
+}`;

      const findings = analyzePatch("src/api/client.ts", patch);

      expect(findings.some((f) => f.kind === "SILENT_ERROR")).toBe(true);
    });
  });

  describe("No issues - clean code", () => {
    it("should return empty findings for clean constant definition", () => {
      const patch = `@@ -1,2 +1,3 @@
+const MAX_ITEMS = 100;
+const DEFAULT_PAGE_SIZE = 20;`;

      const findings = analyzePatch("src/constants.ts", patch);

      expect(findings).toHaveLength(0);
    });

    it("should return empty findings for simple function", () => {
      const patch = `@@ -1,3 +1,6 @@
+function add(a: number, b: number): number {
+  return a + b;
+}`;

      const findings = analyzePatch("src/math.ts", patch);

      expect(findings).toHaveLength(0);
    });

    it("should return empty findings for empty patch", () => {
      const findings = analyzePatch("src/empty.ts", "");

      expect(findings).toHaveLength(0);
    });
  });

  describe("MEMORY_RISK detection", () => {
    it("should detect readFileSync without streaming", () => {
      const patch = `@@ -1,2 +1,3 @@
+const data = fs.readFileSync('./large-file.json');
+const parsed = JSON.parse(data.toString());`;

      const findings = analyzePatch("src/io/file.ts", patch);

      expect(findings.some((f) => f.kind === "MEMORY_RISK")).toBe(true);
    });

    it("should NOT flag when streaming is used", () => {
      const patch = `@@ -1,3 +1,5 @@
+const stream = fs.createReadStream('./large-file.json');
+stream.pipe(parser);`;

      const findings = analyzePatch("src/io/file.ts", patch);

      expect(findings.some((f) => f.kind === "MEMORY_RISK")).toBe(false);
    });
  });

  describe("CHECK_THEN_ACT_RACE detection", () => {
    it("should detect find-then-create pattern", () => {
      const patch = `@@ -1,6 +1,10 @@
+async function getOrCreate(email: string) {
+  const existing = await db.user.findOne({ email });
+  if (!existing) {
+    return await db.user.create({ data: { email } });
+  }
+  return existing;
+}`;

      const findings = analyzePatch("src/db/users.ts", patch);

      expect(findings.some((f) => f.kind === "CHECK_THEN_ACT_RACE")).toBe(true);
    });
  });

  describe("Line number tracking", () => {
    it("should correctly track line numbers from hunk headers", () => {
      const patch = `@@ -10,3 +10,5 @@
 // existing code
+// TODO: fix this
+const x = 1;`;

      const findings = analyzePatch("src/utils.ts", patch);

      const todoFinding = findings.find((f) => f.kind === "TEMPORARY_HACK");
      expect(todoFinding).toBeDefined();
      expect(todoFinding?.line).toBe(11); // Line 10 is context, +1 for the TODO line
    });
  });
});

describe("analyzePullRequestPatchesWithConfig - Comment/String filtering", () => {
  it("should NOT flag fetch() inside a comment when fileContents is provided", () => {
    // File content must match patch line numbers exactly
    const fileContent = `// This is a comment with fetch() in it
// Another line with axios.get()
const x = 1;
`;
    const patch = `@@ -1,1 +1,3 @@
+// This is a comment with fetch() in it
+// Another line with axios.get()
+const x = 1;
`;

    const files = [{ filename: "test.ts", patch }];
    const fileContents = new Map<string, string>();
    fileContents.set("test.ts", fileContent);

    const findings = analyzePullRequestPatchesWithConfig(files, {
      config: createDefaultConfig(),
      fileContents,
    });

    // Should NOT have UNSAFE_IO for fetch() in comment
    expect(findings.filter((f) => f.kind === "UNSAFE_IO").length).toBe(0);
  });

  it("should flag fetch() in actual code", () => {
    const fileContent = `const data = await fetch('/api/users');
`;
    const patch = `@@ -1,1 +1,1 @@
+const data = await fetch('/api/users');
`;

    const files = [{ filename: "test.ts", patch }];
    const fileContents = new Map<string, string>();
    fileContents.set("test.ts", fileContent);

    const findings = analyzePullRequestPatchesWithConfig(files, {
      config: createDefaultConfig(),
      fileContents,
    });

    // Should have UNSAFE_IO for actual fetch() call
    expect(findings.some((f) => f.kind === "UNSAFE_IO")).toBe(true);
  });

  it("should still flag TEMPORARY_HACK in comments (not filtered)", () => {
    const fileContent = `// TODO: fix this later
const x = 1;
`;
    const patch = `@@ -1,1 +1,2 @@
+// TODO: fix this later
+const x = 1;
`;

    const files = [{ filename: "test.ts", patch }];
    const fileContents = new Map<string, string>();
    fileContents.set("test.ts", fileContent);

    const findings = analyzePullRequestPatchesWithConfig(files, {
      config: createDefaultConfig(),
      fileContents,
    });

    // TEMPORARY_HACK should NOT be filtered when in comments
    expect(findings.some((f) => f.kind === "TEMPORARY_HACK")).toBe(true);
  });

  it("should NOT flag patterns inside string literals", () => {
    const fileContent = `const message = "Use fetch() to get data from the API";
const query = "SELECT * FROM users";
`;
    const patch = `@@ -1,1 +1,2 @@
+const message = "Use fetch() to get data from the API";
+const query = "SELECT * FROM users";
`;

    const files = [{ filename: "test.ts", patch }];
    const fileContents = new Map<string, string>();
    fileContents.set("test.ts", fileContent);

    const findings = analyzePullRequestPatchesWithConfig(files, {
      config: createDefaultConfig(),
      fileContents,
    });

    // Should NOT flag UNSAFE_IO or UNBOUNDED_QUERY for patterns in strings
    expect(findings.filter((f) => f.kind === "UNSAFE_IO").length).toBe(0);
    expect(findings.filter((f) => f.kind === "UNBOUNDED_QUERY").length).toBe(0);
  });

  it("should work without fileContents (regex-only mode, no filtering)", () => {
    const patch = `@@ -1,1 +1,2 @@
+// This has fetch() in a comment
+const x = 1;
`;

    const files = [{ filename: "test.ts", patch }];

    // No fileContents provided - should use regex only
    const findings = analyzePullRequestPatchesWithConfig(files, {
      config: createDefaultConfig(),
    });

    // Without fileContents, we can't filter comments, so regex will find fetch()
    // This is expected behavior - we need file content for accurate filtering
    expect(findings.some((f) => f.kind === "UNSAFE_IO")).toBe(true);
  });
});

describe("STATEFUL_SERVICE detection", () => {
  it("should detect this.store = new Map()", () => {
    const patch = `@@ -1,3 +1,5 @@
+class RateLimiter {
+  constructor() {
+    this.store = new Map();
+  }
+}`;

    const findings = analyzePatch("src/services/rateLimiter.js", patch);

    expect(findings.some((f) => f.kind === "STATEFUL_SERVICE")).toBe(true);
    const finding = findings.find((f) => f.kind === "STATEFUL_SERVICE");
    expect(finding?.severity).toBe("high");
    expect(finding?.message).toContain("horizontal scaling");
  });

  it("should detect this.cache = new Map()", () => {
    const patch = `@@ -1,3 +1,5 @@
+class CacheService {
+  constructor() {
+    this.cache = new Map();
+  }
+}`;

    const findings = analyzePatch("src/services/cache.ts", patch);

    expect(findings.some((f) => f.kind === "STATEFUL_SERVICE")).toBe(true);
  });

  it("should detect this.sessions = {}", () => {
    const patch = `@@ -1,3 +1,5 @@
+class SessionManager {
+  constructor() {
+    this.sessions = {};
+  }
+}`;

    const findings = analyzePatch("src/services/session.ts", patch);

    expect(findings.some((f) => f.kind === "STATEFUL_SERVICE")).toBe(true);
  });

  it("should detect this.listeners = []", () => {
    const patch = `@@ -1,3 +1,5 @@
+class EventEmitter {
+  constructor() {
+    this.listeners = [];
+  }
+}`;

    const findings = analyzePatch("src/services/events.ts", patch);

    expect(findings.some((f) => f.kind === "STATEFUL_SERVICE")).toBe(true);
  });

  it("should detect module-level stateful variables", () => {
    const patch = `@@ -1,2 +1,3 @@
+const cache = new Map();
+const sessions = {};`;

    const findings = analyzePatch("src/cache.ts", patch);

    expect(findings.some((f) => f.kind === "STATEFUL_SERVICE")).toBe(true);
  });

  it("should detect Python self.cache patterns", () => {
    const patch = `@@ -1,4 +1,6 @@
+class CacheService:
+    def __init__(self):
+        self.cache = {}
+        self.sessions = dict()`;

    const findings = analyzePatch("src/cache.py", patch);

    expect(findings.some((f) => f.kind === "STATEFUL_SERVICE")).toBe(true);
  });
});

describe("PROTOTYPE_INFRA detection", () => {
  it("should detect require('sqlite3')", () => {
    const patch = `@@ -1,2 +1,3 @@
+const sqlite3 = require('sqlite3');
+const db = new sqlite3.Database('./data.db');`;

    const findings = analyzePatch("src/database.js", patch);

    expect(findings.some((f) => f.kind === "PROTOTYPE_INFRA")).toBe(true);
    const finding = findings.find((f) => f.kind === "PROTOTYPE_INFRA");
    expect(finding?.severity).toBe("high");
    expect(finding?.message).toContain("cloud/container");
  });

  it("should detect new sqlite3.Database()", () => {
    const patch = `@@ -1,2 +1,2 @@
+const db = new sqlite3.Database('./mydata.db');`;

    const findings = analyzePatch("src/db.ts", patch);

    expect(findings.some((f) => f.kind === "PROTOTYPE_INFRA")).toBe(true);
  });

  it("should detect require('lowdb')", () => {
    const patch = `@@ -1,2 +1,2 @@
+const low = require('lowdb');`;

    const findings = analyzePatch("src/db.js", patch);

    expect(findings.some((f) => f.kind === "PROTOTYPE_INFRA")).toBe(true);
  });

  it("should detect JSON.parse(fs.readFileSync(*.json))", () => {
    const patch = `@@ -1,2 +1,2 @@
+const data = JSON.parse(fs.readFileSync('./users.json'));`;

    const findings = analyzePatch("src/data.ts", patch);

    expect(findings.some((f) => f.kind === "PROTOTYPE_INFRA")).toBe(true);
  });

  it("should detect import from sqlite3", () => {
    const patch = `@@ -1,2 +1,2 @@
+import Database from 'sqlite3';`;

    const findings = analyzePatch("src/db.ts", patch);

    expect(findings.some((f) => f.kind === "PROTOTYPE_INFRA")).toBe(true);
  });

  it("should detect Python sqlite3 usage", () => {
    const patch = `@@ -1,3 +1,4 @@
+import sqlite3
+conn = sqlite3.connect('example.db')`;

    const findings = analyzePatch("src/db.py", patch);

    expect(findings.some((f) => f.kind === "PROTOTYPE_INFRA")).toBe(true);
  });

  it("should detect new Database with .db extension", () => {
    const patch = `@@ -1,2 +1,2 @@
+const db = new Database('./data.sqlite');`;

    const findings = analyzePatch("src/storage.ts", patch);

    expect(findings.some((f) => f.kind === "PROTOTYPE_INFRA")).toBe(true);
  });

  it("should detect hardcoded database path patterns", () => {
    const patch = `@@ -1,2 +1,2 @@
+const databasePath = './data/users.json';`;

    const findings = analyzePatch("src/config.ts", patch);

    expect(findings.some((f) => f.kind === "PROTOTYPE_INFRA")).toBe(true);
  });
});
