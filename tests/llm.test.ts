/**
 * Tests for LLM types and parsing.
 */

import {
  LlmIssueKind,
  LlmIssue,
  LlmAnalysisResult,
  LlmSeverity,
  LLM_ISSUE_KIND_LABELS,
  severityToNumber,
  groupIssuesByKind,
  StaticFindingSummary,
  buildVibePrompt,
  analyzeSnippetWithLlm,
} from "../src/integrations/llm";

// Mock the OpenAI module
jest.mock("openai");

// Mock the config module
jest.mock("../src/env", () => ({
  config: {
    GROQ_API_KEY: "test-api-key",
  },
}));

describe("LLM Types", () => {
  describe("LlmIssueKind", () => {
    it("should have all six production risk categories", () => {
      const kinds: LlmIssueKind[] = [
        "SCALING_RISK",
        "CONCURRENCY_RISK",
        "ENVIRONMENT_ASSUMPTION",
        "DATA_CONTRACT_RISK",
        "OBSERVABILITY_GAP",
        "RESILIENCE_GAP",
      ];

      // Verify each kind has a label
      for (const kind of kinds) {
        expect(LLM_ISSUE_KIND_LABELS[kind]).toBeDefined();
        expect(typeof LLM_ISSUE_KIND_LABELS[kind]).toBe("string");
      }
    });

    it("should have human-readable labels for all kinds", () => {
      expect(LLM_ISSUE_KIND_LABELS.SCALING_RISK).toBe("Scaling Risk");
      expect(LLM_ISSUE_KIND_LABELS.CONCURRENCY_RISK).toBe("Concurrency Risk");
      expect(LLM_ISSUE_KIND_LABELS.ENVIRONMENT_ASSUMPTION).toBe("Environment Assumption");
      expect(LLM_ISSUE_KIND_LABELS.DATA_CONTRACT_RISK).toBe("Data Contract Risk");
      expect(LLM_ISSUE_KIND_LABELS.OBSERVABILITY_GAP).toBe("Observability Gap");
      expect(LLM_ISSUE_KIND_LABELS.RESILIENCE_GAP).toBe("Resilience Gap");
    });
  });

  describe("LlmIssue interface", () => {
    it("should allow creating a valid issue with all fields", () => {
      const issue: LlmIssue = {
        kind: "SCALING_RISK",
        title: "Unbounded query without pagination",
        file: "src/api/users.ts",
        line: 42,
        summary: "The query fetches all users without a LIMIT clause.",
        evidenceSnippet: "const users = await db.users.findMany();",
        suggestedFix: "Add pagination with take/skip or cursor-based pagination.",
        severity: "high",
      };

      expect(issue.kind).toBe("SCALING_RISK");
      expect(issue.severity).toBe("high");
      expect(issue.file).toBe("src/api/users.ts");
      expect(issue.line).toBe(42);
    });

    it("should allow creating an issue with only required fields", () => {
      const issue: LlmIssue = {
        kind: "CONCURRENCY_RISK",
        title: "Race condition in update",
        summary: "Check-then-act pattern without locking.",
        severity: "medium",
      };

      expect(issue.kind).toBe("CONCURRENCY_RISK");
      expect(issue.file).toBeUndefined();
      expect(issue.line).toBeUndefined();
      expect(issue.evidenceSnippet).toBeUndefined();
      expect(issue.suggestedFix).toBeUndefined();
    });
  });

  describe("LlmAnalysisResult interface", () => {
    it("should allow creating a result with issues and architectureSummary", () => {
      const result: LlmAnalysisResult = {
        issues: [
          {
            kind: "SCALING_RISK",
            title: "N+1 query pattern",
            summary: "Fetching related data in a loop.",
            severity: "high",
          },
          {
            kind: "OBSERVABILITY_GAP",
            title: "Missing error logging",
            summary: "Catch block swallows errors without logging.",
            severity: "medium",
          },
        ],
        architectureSummary:
          "The codebase has significant scaling risks due to N+1 queries and missing pagination. " +
          "Error handling is present but lacks proper observability.",
      };

      expect(result.issues).toHaveLength(2);
      expect(result.architectureSummary).toContain("scaling risks");
    });

    it("should allow creating an empty result", () => {
      const result: LlmAnalysisResult = {
        issues: [],
        architectureSummary: undefined,
      };

      expect(result.issues).toHaveLength(0);
      expect(result.architectureSummary).toBeUndefined();
    });
  });

  describe("LlmSeverity", () => {
    it("should have three valid severity levels", () => {
      const severities: LlmSeverity[] = ["low", "medium", "high"];

      for (const sev of severities) {
        expect(["low", "medium", "high"]).toContain(sev);
      }
    });
  });
});

describe("LLM Utility Functions", () => {
  describe("severityToNumber", () => {
    it("should convert severity strings to numbers", () => {
      expect(severityToNumber("low")).toBe(1);
      expect(severityToNumber("medium")).toBe(2);
      expect(severityToNumber("high")).toBe(3);
    });
  });

  describe("groupIssuesByKind", () => {
    it("should group issues by their kind", () => {
      const issues: LlmIssue[] = [
        { kind: "SCALING_RISK", title: "Issue 1", summary: "Summary 1", severity: "high" },
        { kind: "SCALING_RISK", title: "Issue 2", summary: "Summary 2", severity: "medium" },
        { kind: "CONCURRENCY_RISK", title: "Issue 3", summary: "Summary 3", severity: "low" },
        { kind: "OBSERVABILITY_GAP", title: "Issue 4", summary: "Summary 4", severity: "medium" },
      ];

      const grouped = groupIssuesByKind(issues);

      expect(grouped.get("SCALING_RISK")).toHaveLength(2);
      expect(grouped.get("CONCURRENCY_RISK")).toHaveLength(1);
      expect(grouped.get("OBSERVABILITY_GAP")).toHaveLength(1);
      expect(grouped.get("RESILIENCE_GAP")).toBeUndefined();
    });

    it("should return empty map for empty issues array", () => {
      const grouped = groupIssuesByKind([]);
      expect(grouped.size).toBe(0);
    });
  });
});

describe("LLM Response Parsing", () => {
  it("should parse a valid LLM JSON response", () => {
    // This simulates what the LLM would return
    const llmJsonResponse = `{
      "issues": [
        {
          "kind": "SCALING_RISK",
          "title": "Unbounded database query",
          "file": "src/api/products.ts",
          "line": 15,
          "summary": "The findMany() call has no limit, which will cause performance issues as the database grows.",
          "evidenceSnippet": "const products = await prisma.product.findMany();",
          "suggestedFix": "Add pagination with take/skip parameters.",
          "severity": "high"
        },
        {
          "kind": "ENVIRONMENT_ASSUMPTION",
          "title": "Missing timeout on external API call",
          "summary": "The fetch call to the payment service has no timeout configured.",
          "severity": "medium"
        }
      ],
      "architectureSummary": "This code has scaling concerns due to unbounded queries and makes assumptions about external service availability."
    }`;

    const parsed = JSON.parse(llmJsonResponse);

    expect(parsed.issues).toHaveLength(2);
    expect(parsed.issues[0].kind).toBe("SCALING_RISK");
    expect(parsed.issues[0].severity).toBe("high");
    expect(parsed.issues[1].kind).toBe("ENVIRONMENT_ASSUMPTION");
    expect(parsed.architectureSummary).toContain("scaling concerns");
  });

  it("should handle a response with no issues", () => {
    const llmJsonResponse = `{
      "issues": [],
      "architectureSummary": null
    }`;

    const parsed = JSON.parse(llmJsonResponse);

    expect(parsed.issues).toHaveLength(0);
    expect(parsed.architectureSummary).toBeNull();
  });
});

describe("Prompt Content", () => {
  it("should define all six issue kinds in the module", () => {
    // The VALID_KINDS array in the module should have all six
    const allKinds: LlmIssueKind[] = [
      "SCALING_RISK",
      "CONCURRENCY_RISK",
      "ENVIRONMENT_ASSUMPTION",
      "DATA_CONTRACT_RISK",
      "OBSERVABILITY_GAP",
      "RESILIENCE_GAP",
    ];

    // Each kind should have a corresponding label
    for (const kind of allKinds) {
      expect(LLM_ISSUE_KIND_LABELS[kind]).toBeDefined();
    }

    // Verify we have exactly 6 kinds
    expect(Object.keys(LLM_ISSUE_KIND_LABELS)).toHaveLength(6);
  });
});

describe("StaticFindingSummary", () => {
  it("should allow creating a valid static finding summary", () => {
    const summary: StaticFindingSummary = {
      ruleId: "UNBOUNDED_QUERY",
      kind: "UNBOUNDED_QUERY",
      file: "src/api/users.ts",
      line: 42,
      severity: "high",
      summary: "Database query has no LIMIT clause",
    };

    expect(summary.ruleId).toBe("UNBOUNDED_QUERY");
    expect(summary.kind).toBe("UNBOUNDED_QUERY");
    expect(summary.file).toBe("src/api/users.ts");
    expect(summary.line).toBe(42);
    expect(summary.severity).toBe("high");
    expect(summary.summary).toBe("Database query has no LIMIT clause");
  });

  it("should allow all severity levels", () => {
    const lowSeverity: StaticFindingSummary = {
      ruleId: "CONSOLE_DEBUG",
      kind: "CONSOLE_DEBUG",
      file: "src/utils.ts",
      line: 10,
      severity: "low",
      summary: "Console.log statement found",
    };

    const mediumSeverity: StaticFindingSummary = {
      ruleId: "MISSING_TRY_CATCH",
      kind: "MISSING_TRY_CATCH",
      file: "src/api.ts",
      line: 20,
      severity: "medium",
      summary: "Missing error handling",
    };

    const highSeverity: StaticFindingSummary = {
      ruleId: "N_PLUS_ONE",
      kind: "N_PLUS_ONE",
      file: "src/db.ts",
      line: 30,
      severity: "high",
      summary: "N+1 query pattern detected",
    };

    expect(lowSeverity.severity).toBe("low");
    expect(mediumSeverity.severity).toBe("medium");
    expect(highSeverity.severity).toBe("high");
  });
});

describe("buildVibePrompt", () => {
  it("should build a prompt without static findings", () => {
    const prompt = buildVibePrompt({
      file: "src/api/users.ts",
      language: "TypeScript",
      snippet: "const users = await db.users.findMany();",
    });

    expect(prompt).toContain("src/api/users.ts");
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("const users = await db.users.findMany();");
    expect(prompt).toContain("SCALING_RISK");
    expect(prompt).toContain("CONCURRENCY_RISK");
    expect(prompt).toContain("ENVIRONMENT_ASSUMPTION");
    expect(prompt).toContain("DATA_CONTRACT_RISK");
    expect(prompt).toContain("OBSERVABILITY_GAP");
    expect(prompt).toContain("RESILIENCE_GAP");
    // Should NOT contain static findings section when not provided
    expect(prompt).not.toContain("static analysis findings that were already detected");
  });

  it("should include static findings in the prompt when provided", () => {
    const staticFindings: StaticFindingSummary[] = [
      {
        ruleId: "UNBOUNDED_QUERY",
        kind: "UNBOUNDED_QUERY",
        file: "src/api/users.ts",
        line: 10,
        severity: "high",
        summary: "Database query without LIMIT",
      },
      {
        ruleId: "CONSOLE_DEBUG",
        kind: "CONSOLE_DEBUG",
        file: "src/api/users.ts",
        line: 15,
        severity: "low",
        summary: "Console.log debugging statement",
      },
    ];

    const prompt = buildVibePrompt({
      file: "src/api/users.ts",
      language: "TypeScript",
      snippet: "const users = await db.users.findMany();\nconsole.log(users);",
      staticFindings,
    });

    // Should contain the static findings section
    expect(prompt).toContain("static analysis findings that were already detected");
    // Should contain the rule IDs from the findings
    expect(prompt).toContain("UNBOUNDED_QUERY");
    expect(prompt).toContain("CONSOLE_DEBUG");
    // Should contain the summaries
    expect(prompt).toContain("Database query without LIMIT");
    expect(prompt).toContain("Console.log debugging statement");
    // Should still contain the LLM issue kinds
    expect(prompt).toContain("SCALING_RISK");
  });

  it("should handle empty static findings array", () => {
    const prompt = buildVibePrompt({
      file: "src/api/users.ts",
      snippet: "const x = 1;",
      staticFindings: [],
    });

    // Should NOT contain static findings section when array is empty
    expect(prompt).not.toContain("static analysis findings that were already detected");
    // Should still work as a valid prompt
    expect(prompt).toContain("src/api/users.ts");
    expect(prompt).toContain("const x = 1;");
  });

  it("should cap static findings at 50 to avoid token explosion", () => {
    // Create 60 findings
    const manyFindings: StaticFindingSummary[] = [];
    for (let i = 0; i < 60; i++) {
      manyFindings.push({
        ruleId: `RULE_${i}`,
        kind: `RULE_${i}`,
        file: "src/test.ts",
        line: i + 1,
        severity: "medium",
        summary: `Finding number ${i}`,
      });
    }

    const prompt = buildVibePrompt({
      file: "src/test.ts",
      snippet: "const x = 1;",
      staticFindings: manyFindings,
    });

    // Should contain the first 50 findings
    expect(prompt).toContain("RULE_0");
    expect(prompt).toContain("RULE_49");
    // Should NOT contain findings beyond 50
    expect(prompt).not.toContain("RULE_50");
    expect(prompt).not.toContain("RULE_59");
  });

  it("should include diff context when provided", () => {
    const prompt = buildVibePrompt({
      file: "src/api/users.ts",
      snippet: "const users = await db.users.findMany();",
      diffContext: "@@ -10,5 +10,7 @@\n+ const users = await db.users.findMany();",
    });

    expect(prompt).toContain("Diff context");
    expect(prompt).toContain("@@ -10,5 +10,7 @@");
  });
});

// ============================================================================
// LLM Failure Handling Tests (Phase 3)
// ============================================================================

describe("analyzeSnippetWithLlm Error Handling", () => {
  // Get reference to the mocked OpenAI
  const OpenAI = require("openai").default;
  let mockCreate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate = jest.fn();
    OpenAI.mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    }));
  });

  describe("API Errors", () => {
    it("should return null when OpenAI API throws a network error", async () => {
      mockCreate.mockRejectedValue(new Error("Network error: Connection refused"));

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).toBeNull();
    });

    it("should return null when OpenAI API throws a rate limit error", async () => {
      const rateLimitError = new Error("Rate limit exceeded");
      (rateLimitError as any).status = 429;
      mockCreate.mockRejectedValue(rateLimitError);

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).toBeNull();
    });

    it("should return null when OpenAI API throws a 500 server error", async () => {
      const serverError = new Error("Internal Server Error");
      (serverError as any).status = 500;
      mockCreate.mockRejectedValue(serverError);

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).toBeNull();
    });

    it("should return null when OpenAI API throws a timeout error", async () => {
      mockCreate.mockRejectedValue(new Error("Request timeout after 30000ms"));

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).toBeNull();
    });

    it("should return null when OpenAI API throws authentication error", async () => {
      const authError = new Error("Invalid API key");
      (authError as any).status = 401;
      mockCreate.mockRejectedValue(authError);

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).toBeNull();
    });
  });

  describe("Empty/Invalid Responses", () => {
    it("should return empty issues when response has no content", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null } }],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(0);
    });

    it("should return empty issues when response has empty string content", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "" } }],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(0);
    });

    it("should return empty issues when choices array is empty", async () => {
      mockCreate.mockResolvedValue({
        choices: [],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(0);
    });
  });

  describe("Malformed JSON Responses", () => {
    it("should return empty issues when response is not valid JSON", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "This is not JSON at all!" } }],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(0);
    });

    it("should return empty issues when response is truncated JSON", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{"issues": [{"kind": "SCALING_RISK", "title": "Incomplete' } }],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(0);
    });

    it("should return empty issues when response has wrong structure", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{"wrongKey": "wrongValue"}' } }],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(0);
    });

    it("should handle issues with invalid severity gracefully", async () => {
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              issues: [{
                kind: "SCALING_RISK",
                title: "Test issue",
                summary: "Test summary",
                severity: "invalid_severity", // Invalid severity
              }],
            }),
          },
        }],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(1);
      // Should default to "medium" for invalid severity
      expect(result?.issues[0].severity).toBe("medium");
    });

    it("should handle issues with invalid kind gracefully", async () => {
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              issues: [{
                kind: "INVALID_KIND", // Invalid kind
                title: "Test issue",
                summary: "Test summary",
                severity: "high",
              }],
            }),
          },
        }],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(1);
      // Should default to "SCALING_RISK" for invalid kind
      expect(result?.issues[0].kind).toBe("SCALING_RISK");
    });

    it("should extract JSON even when surrounded by extra text", async () => {
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: `Here is my analysis:
{
  "issues": [{
    "kind": "SCALING_RISK",
    "title": "Unbounded query",
    "summary": "No limit on query",
    "severity": "high"
  }],
  "architectureSummary": "Test summary"
}
I hope this helps!`,
          },
        }],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(1);
      expect(result?.issues[0].kind).toBe("SCALING_RISK");
      expect(result?.architectureSummary).toBe("Test summary");
    });
  });

  describe("Successful Responses", () => {
    it("should parse a valid response correctly", async () => {
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              issues: [
                {
                  kind: "SCALING_RISK",
                  title: "Unbounded database query",
                  file: "src/api/users.ts",
                  line: 10,
                  summary: "The findMany() call has no limit.",
                  evidenceSnippet: "await db.users.findMany()",
                  suggestedFix: "Add pagination with take/skip.",
                  severity: "high",
                },
                {
                  kind: "OBSERVABILITY_GAP",
                  title: "Missing error logging",
                  summary: "No structured logging for errors.",
                  severity: "medium",
                },
              ],
              architectureSummary: "Code has scaling and observability concerns.",
            }),
          },
        }],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const users = await db.users.findMany();",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(2);
      expect(result?.issues[0].kind).toBe("SCALING_RISK");
      expect(result?.issues[0].title).toBe("Unbounded database query");
      expect(result?.issues[0].severity).toBe("high");
      expect(result?.issues[1].kind).toBe("OBSERVABILITY_GAP");
      expect(result?.architectureSummary).toBe("Code has scaling and observability concerns.");
    });

    it("should handle response with empty issues array", async () => {
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              issues: [],
              architectureSummary: null,
            }),
          },
        }],
      });

      const result = await analyzeSnippetWithLlm({
        file: "src/api/users.ts",
        snippet: "const x = 1;",
      });

      expect(result).not.toBeNull();
      expect(result?.issues).toHaveLength(0);
      expect(result?.architectureSummary).toBeUndefined();
    });
  });
});

describe("analyzeSnippetWithLlm with Missing API Key", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("should return null when GROQ_API_KEY is not configured", async () => {
    // Re-mock with no API key
    jest.doMock("../src/env", () => ({
      config: {
        GROQ_API_KEY: "",
      },
    }));

    // Re-import the module to pick up the new mock
    const { analyzeSnippetWithLlm: analyzeWithNoKey } = require("../src/integrations/llm");

    const result = await analyzeWithNoKey({
      file: "src/api/users.ts",
      snippet: "const users = await db.users.findMany();",
    });

    expect(result).toBeNull();
  });
});
