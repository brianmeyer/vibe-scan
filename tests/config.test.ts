/**
 * Tests for Vibe Scan configuration and suppression system.
 */

import * as path from "path";
import { loadConfig, loadConfigFromString, createDefaultConfig } from "../src/config/loader";
import { parseSuppressionDirectives, isSuppressed } from "../src/config/suppression";
import { DEFAULT_RULE_CONFIG } from "../src/analysis/rules";

const FIXTURES_DIR = path.join(__dirname, "fixtures/vibescan-config");

describe("Config Loading", () => {
  describe("loadConfig", () => {
    it("should load config from .vibescan.yml file", () => {
      const config = loadConfig(FIXTURES_DIR);

      expect(config.raw.version).toBe(1);
      expect(config.raw.rules?.TEMPORARY_HACK?.level).toBe("warning");
      expect(config.raw.rules?.CONSOLE_DEBUG?.enabled).toBe(false);
    });

    it("should return defaults when no config file exists", () => {
      const config = loadConfig("/nonexistent/path");

      expect(config.raw.version).toBe(1);
      expect(config.scoring.high_risk_vibe_score).toBe(60);
      expect(config.scoring.weight_multiplier).toBe(1.0);
    });

    it("should merge defaults with config file values", () => {
      const config = loadConfig(FIXTURES_DIR);

      // UNSAFE_IO is not in the config file, should use default
      const unsafeIoConfig = config.getRuleConfig("UNSAFE_IO");
      expect(unsafeIoConfig.enabled).toBe(DEFAULT_RULE_CONFIG.UNSAFE_IO.enabled);
      expect(unsafeIoConfig.level).toBe(DEFAULT_RULE_CONFIG.UNSAFE_IO.level);
    });
  });

  describe("createDefaultConfig", () => {
    it("should return default configuration", () => {
      const config = createDefaultConfig();

      expect(config.raw.version).toBe(1);
      expect(config.scoring.high_risk_vibe_score).toBe(60);
      expect(config.llm.enabled).toBe(true);
    });
  });

  describe("loadConfigFromString", () => {
    it("should parse YAML config string", () => {
      const yaml = `
version: 1
rules:
  TEMPORARY_HACK:
    enabled: false
    level: info
scoring:
  high_risk_vibe_score: 50
`;
      const config = loadConfigFromString(yaml);

      expect(config.raw.rules?.TEMPORARY_HACK?.enabled).toBe(false);
      expect(config.scoring.high_risk_vibe_score).toBe(50);
    });
  });
});

describe("File Filtering", () => {
  describe("isFileIgnored", () => {
    it("should match ignore patterns", () => {
      const config = loadConfig(FIXTURES_DIR);

      expect(config.isFileIgnored("tests/foo.ts")).toBe(true);
      expect(config.isFileIgnored("src/foo.spec.ts")).toBe(true);
      expect(config.isFileIgnored("scripts/migrations/001.sql")).toBe(true);
      expect(config.isFileIgnored("src/main.ts")).toBe(false);
    });

    it("should work with default config (no ignores)", () => {
      const config = createDefaultConfig();

      expect(config.isFileIgnored("tests/foo.ts")).toBe(false);
      expect(config.isFileIgnored("src/main.ts")).toBe(false);
    });
  });

  describe("isPrototypeZone", () => {
    it("should match prototype zone patterns", () => {
      const config = loadConfig(FIXTURES_DIR);

      expect(config.isPrototypeZone("playground/test.ts")).toBe(true);
      expect(config.isPrototypeZone("experiments/new-feature.ts")).toBe(true);
      expect(config.isPrototypeZone("src/main.ts")).toBe(false);
    });
  });
});

describe("Rule Configuration", () => {
  describe("getRuleConfig", () => {
    it("should return default config for unconfigured rules", () => {
      const config = loadConfig(FIXTURES_DIR);

      const ruleConfig = config.getRuleConfig("UNSAFE_IO");
      expect(ruleConfig.enabled).toBe(true);
      expect(ruleConfig.level).toBe("error");
    });

    it("should return config file overrides", () => {
      const config = loadConfig(FIXTURES_DIR);

      const tempHackConfig = config.getRuleConfig("TEMPORARY_HACK");
      expect(tempHackConfig.enabled).toBe(true);
      expect(tempHackConfig.level).toBe("warning");

      const consoleDebugConfig = config.getRuleConfig("CONSOLE_DEBUG");
      expect(consoleDebugConfig.enabled).toBe(false);
    });

    it("should apply path-specific overrides", () => {
      const config = loadConfig(FIXTURES_DIR);

      // NO_CACHING should be "error" for src/infra/** files
      const infraCacheConfig = config.getRuleConfig("NO_CACHING", "src/infra/cache.ts");
      expect(infraCacheConfig.level).toBe("error");

      // NO_CACHING should be default ("warning") for other files
      const otherCacheConfig = config.getRuleConfig("NO_CACHING", "src/main.ts");
      expect(otherCacheConfig.level).toBe("warning");
    });

    it("should apply prototype zone overrides", () => {
      const config = loadConfig(FIXTURES_DIR);

      // TEMPORARY_HACK should be "info" for playground/** files
      const playgroundHackConfig = config.getRuleConfig("TEMPORARY_HACK", "playground/test.ts");
      expect(playgroundHackConfig.level).toBe("info");

      // UNBOUNDED_QUERY should be disabled for playground/** files
      const playgroundQueryConfig = config.getRuleConfig("UNBOUNDED_QUERY", "playground/test.ts");
      expect(playgroundQueryConfig.enabled).toBe(false);
    });
  });
});

describe("Suppression Directives", () => {
  describe("parseSuppressionDirectives", () => {
    it("should parse file-level ALL suppression", () => {
      const source = `/* vibescan-ignore-file ALL */
const x = 1;`;

      const directives = parseSuppressionDirectives(source);
      expect(directives).toHaveLength(1);
      expect(directives[0].scope).toBe("file");
      expect(directives[0].allRules).toBe(true);
    });

    it("should parse file-level specific rule suppression", () => {
      const source = `/* vibescan-ignore-file CONSOLE_DEBUG */
console.log("test");`;

      const directives = parseSuppressionDirectives(source);
      expect(directives).toHaveLength(1);
      expect(directives[0].scope).toBe("file");
      expect(directives[0].allRules).toBe(false);
      expect(directives[0].rules).toContain("CONSOLE_DEBUG");
    });

    it("should parse line suppression", () => {
      const source = `const x = fetch("/api"); // vibescan-ignore-line UNSAFE_IO`;

      const directives = parseSuppressionDirectives(source);
      expect(directives).toHaveLength(1);
      expect(directives[0].scope).toBe("line");
      expect(directives[0].line).toBe(1);
      expect(directives[0].rules).toContain("UNSAFE_IO");
    });

    it("should parse next-line suppression", () => {
      const source = `// vibescan-ignore-next-line TEMPORARY_HACK
// TODO: fix this`;

      const directives = parseSuppressionDirectives(source);
      expect(directives).toHaveLength(1);
      expect(directives[0].scope).toBe("next-line");
      expect(directives[0].line).toBe(1);
      expect(directives[0].rules).toContain("TEMPORARY_HACK");
    });

    it("should parse multiple rules in one directive", () => {
      const source = `// vibescan-ignore-next-line UNBOUNDED_QUERY,LOOPED_IO
const items = await db.findMany();`;

      const directives = parseSuppressionDirectives(source);
      expect(directives).toHaveLength(1);
      expect(directives[0].rules).toContain("UNBOUNDED_QUERY");
      expect(directives[0].rules).toContain("LOOPED_IO");
    });

    it("should ignore invalid rule IDs", () => {
      const source = `// vibescan-ignore-line INVALID_RULE,UNSAFE_IO`;

      const directives = parseSuppressionDirectives(source);
      expect(directives).toHaveLength(1);
      expect(directives[0].rules).not.toContain("INVALID_RULE");
      expect(directives[0].rules).toContain("UNSAFE_IO");
    });
  });

  describe("isSuppressed", () => {
    it("should suppress with file-level ALL directive", () => {
      const source = `/* vibescan-ignore-file ALL */`;
      const directives = parseSuppressionDirectives(source);

      expect(isSuppressed("UNSAFE_IO", 5, directives)).toBe(true);
      expect(isSuppressed("TEMPORARY_HACK", 10, directives)).toBe(true);
    });

    it("should suppress specific rules at file level", () => {
      const source = `/* vibescan-ignore-file CONSOLE_DEBUG */`;
      const directives = parseSuppressionDirectives(source);

      expect(isSuppressed("CONSOLE_DEBUG", 5, directives)).toBe(true);
      expect(isSuppressed("UNSAFE_IO", 5, directives)).toBe(false);
    });

    it("should suppress on same line with line directive", () => {
      const source = `const x = 1; // vibescan-ignore-line UNSAFE_IO`;
      const directives = parseSuppressionDirectives(source);

      expect(isSuppressed("UNSAFE_IO", 1, directives)).toBe(true);
      expect(isSuppressed("UNSAFE_IO", 2, directives)).toBe(false);
    });

    it("should suppress next line with next-line directive", () => {
      const source = `// vibescan-ignore-next-line TEMPORARY_HACK
// TODO: fix`;
      const directives = parseSuppressionDirectives(source);

      expect(isSuppressed("TEMPORARY_HACK", 1, directives)).toBe(false);
      expect(isSuppressed("TEMPORARY_HACK", 2, directives)).toBe(true);
      expect(isSuppressed("TEMPORARY_HACK", 3, directives)).toBe(false);
    });
  });
});

describe("Scoring with Config", () => {
  // Import scoring separately to avoid circular dependency issues
  const { computeVibeScore, LEVEL_WEIGHT } = require("../src/analysis/scoring");

  it("should apply level weights to scoring", () => {
    const errorFinding = {
      file: "test.ts",
      line: 1,
      severity: "high" as const,
      kind: "UNSAFE_IO",
      message: "test",
      level: "error" as const,
    };

    const warningFinding = {
      ...errorFinding,
      level: "warning" as const,
    };

    const errorResult = computeVibeScore({
      staticFindings: [errorFinding],
      llmIssues: [],
    });

    const warningResult = computeVibeScore({
      staticFindings: [warningFinding],
      llmIssues: [],
    });

    // Warning should have less impact than error
    expect(warningResult.score).toBeGreaterThan(errorResult.score);
  });

  it("should use weight_multiplier from config", () => {
    const finding = {
      file: "test.ts",
      line: 1,
      severity: "high" as const,
      kind: "UNSAFE_IO",
      message: "test",
      level: "error" as const,
    };

    const normalResult = computeVibeScore({
      staticFindings: [finding],
      llmIssues: [],
      options: { scoringConfig: { high_risk_vibe_score: 60, weight_multiplier: 1.0 } },
    });

    const reducedResult = computeVibeScore({
      staticFindings: [finding],
      llmIssues: [],
      options: { scoringConfig: { high_risk_vibe_score: 60, weight_multiplier: 0.5 } },
    });

    // Reduced multiplier should result in higher score
    expect(reducedResult.score).toBeGreaterThan(normalResult.score);
  });

  it("should determine isHighRisk based on threshold", () => {
    const findings = [
      { file: "test.ts", line: 1, severity: "high" as const, kind: "UNSAFE_IO", message: "test" },
      { file: "test.ts", line: 2, severity: "high" as const, kind: "UNSAFE_IO", message: "test" },
      { file: "test.ts", line: 3, severity: "high" as const, kind: "UNSAFE_IO", message: "test" },
      { file: "test.ts", line: 4, severity: "high" as const, kind: "UNSAFE_IO", message: "test" },
      { file: "test.ts", line: 5, severity: "high" as const, kind: "UNSAFE_IO", message: "test" },
    ];

    const resultHighThreshold = computeVibeScore({
      staticFindings: findings,
      llmIssues: [],
      options: { scoringConfig: { high_risk_vibe_score: 80, weight_multiplier: 1.0 } },
    });

    const resultLowThreshold = computeVibeScore({
      staticFindings: findings,
      llmIssues: [],
      options: { scoringConfig: { high_risk_vibe_score: 40, weight_multiplier: 1.0 } },
    });

    // Same score, different thresholds
    expect(resultHighThreshold.score).toBe(resultLowThreshold.score);
    expect(resultHighThreshold.isHighRisk).toBe(true); // Below 80
    expect(resultLowThreshold.isHighRisk).toBe(false); // Above 40
  });
});
