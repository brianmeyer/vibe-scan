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
} from "../src/llm";

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
  // We can't easily test the prompt building function without exporting it,
  // but we can verify the prompt contains all required kinds by reading the source

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
