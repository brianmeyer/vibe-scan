/**
 * Configuration loader for Vibe Scan.
 *
 * Loads and merges configuration from .vibescan.yml files,
 * applying defaults and handling overrides.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { minimatch } from "minimatch";
import {
  DEFAULT_RULE_CONFIG,
  RequiredRuleConfig,
  RuleConfig,
  RuleId,
  isValidRuleId,
} from "../analysis/rules";
import {
  VibeScanConfig,
  RequiredScoringConfig,
  RequiredLlmConfig,
  DEFAULT_SCORING_CONFIG,
  DEFAULT_LLM_CONFIG,
  DEFAULT_FILES_CONFIG,
} from "./schema";

/**
 * The loaded and resolved configuration with helper methods.
 */
export interface LoadedConfig {
  /**
   * The raw parsed configuration (or defaults if no file found).
   */
  raw: VibeScanConfig;

  /**
   * Check if a file should be completely ignored from analysis.
   * @param filePath - Relative file path from repo root
   */
  isFileIgnored(filePath: string): boolean;

  /**
   * Check if a file is in a "prototype zone".
   * @param filePath - Relative file path from repo root
   */
  isPrototypeZone(filePath: string): boolean;

  /**
   * Get the effective rule configuration for a rule, optionally for a specific file.
   * Merges defaults -> config.rules -> overrides in order.
   * @param ruleId - The rule ID
   * @param filePath - Optional relative file path for override matching
   */
  getRuleConfig(ruleId: RuleId, filePath?: string): RequiredRuleConfig;

  /**
   * Resolved scoring configuration with all defaults applied.
   */
  scoring: RequiredScoringConfig;

  /**
   * Resolved LLM configuration with all defaults applied.
   */
  llm: RequiredLlmConfig;
}

/**
 * Default empty configuration when no .vibescan.yml is present.
 */
const DEFAULT_CONFIG: VibeScanConfig = {
  version: 1,
  rules: {},
  files: DEFAULT_FILES_CONFIG,
  scoring: DEFAULT_SCORING_CONFIG,
  llm: DEFAULT_LLM_CONFIG,
  overrides: [],
};

/**
 * Config file name to search for in repo root.
 */
const CONFIG_FILE_NAME = ".vibescan.yml";

/**
 * Load configuration from a repository root directory.
 *
 * @param repoRoot - Path to the repository root directory
 * @returns LoadedConfig with resolved values and helper methods
 */
export function loadConfig(repoRoot: string): LoadedConfig {
  const configPath = path.join(repoRoot, CONFIG_FILE_NAME);
  let rawConfig: VibeScanConfig = { ...DEFAULT_CONFIG };

  // Try to load the config file
  if (fs.existsSync(configPath)) {
    try {
      const fileContents = fs.readFileSync(configPath, "utf-8");
      const parsed = yaml.load(fileContents) as Partial<VibeScanConfig> | null;

      if (parsed && typeof parsed === "object") {
        rawConfig = {
          version: parsed.version ?? 1,
          rules: parsed.rules ?? {},
          files: {
            ignore: parsed.files?.ignore ?? [],
            prototype_zone: parsed.files?.prototype_zone ?? [],
          },
          scoring: {
            high_risk_vibe_score:
              parsed.scoring?.high_risk_vibe_score ??
              DEFAULT_SCORING_CONFIG.high_risk_vibe_score,
            weight_multiplier:
              parsed.scoring?.weight_multiplier ??
              DEFAULT_SCORING_CONFIG.weight_multiplier,
          },
          llm: {
            enabled: parsed.llm?.enabled ?? DEFAULT_LLM_CONFIG.enabled,
            max_model_tokens:
              parsed.llm?.max_model_tokens ?? DEFAULT_LLM_CONFIG.max_model_tokens,
            temperature: parsed.llm?.temperature ?? DEFAULT_LLM_CONFIG.temperature,
            max_files: parsed.llm?.max_files ?? DEFAULT_LLM_CONFIG.max_files,
          },
          overrides: parsed.overrides ?? [],
        };
      }
    } catch (err) {
      console.warn(`[Config] Failed to parse ${CONFIG_FILE_NAME}:`, err);
      // Fall back to defaults
    }
  }

  // Build resolved scoring and LLM configs
  const scoring: RequiredScoringConfig = {
    high_risk_vibe_score:
      rawConfig.scoring?.high_risk_vibe_score ??
      DEFAULT_SCORING_CONFIG.high_risk_vibe_score,
    weight_multiplier:
      rawConfig.scoring?.weight_multiplier ??
      DEFAULT_SCORING_CONFIG.weight_multiplier,
  };

  const llm: RequiredLlmConfig = {
    enabled: rawConfig.llm?.enabled ?? DEFAULT_LLM_CONFIG.enabled,
    max_model_tokens:
      rawConfig.llm?.max_model_tokens ?? DEFAULT_LLM_CONFIG.max_model_tokens,
    temperature: rawConfig.llm?.temperature ?? DEFAULT_LLM_CONFIG.temperature,
    max_files: rawConfig.llm?.max_files ?? DEFAULT_LLM_CONFIG.max_files,
  };

  // Build ignore and prototype zone patterns
  const ignorePatterns = rawConfig.files?.ignore ?? [];
  const prototypeZonePatterns = rawConfig.files?.prototype_zone ?? [];

  /**
   * Check if a file matches any of the given glob patterns.
   */
  function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
    const normalizedPath = filePath.replace(/\\/g, "/");
    return patterns.some((pattern) =>
      minimatch(normalizedPath, pattern, { dot: true })
    );
  }

  /**
   * Check if a file should be ignored from analysis.
   */
  function isFileIgnored(filePath: string): boolean {
    return matchesAnyPattern(filePath, ignorePatterns);
  }

  /**
   * Check if a file is in a prototype zone.
   */
  function isPrototypeZone(filePath: string): boolean {
    return matchesAnyPattern(filePath, prototypeZonePatterns);
  }

  /**
   * Get the effective rule configuration for a rule and optional file path.
   */
  function getRuleConfig(ruleId: RuleId, filePath?: string): RequiredRuleConfig {
    // Start with defaults
    const defaultConfig = DEFAULT_RULE_CONFIG[ruleId];
    let result: RequiredRuleConfig = { ...defaultConfig };

    // Apply global rule config if present
    const globalRuleConfig = rawConfig.rules?.[ruleId];
    if (globalRuleConfig) {
      result = mergeRuleConfig(result, globalRuleConfig);
    }

    // Apply overrides for the file path
    if (filePath && rawConfig.overrides) {
      for (const override of rawConfig.overrides) {
        if (matchesAnyPattern(filePath, override.patterns)) {
          const overrideRuleConfig = override.rules[ruleId];
          if (overrideRuleConfig) {
            result = mergeRuleConfig(result, overrideRuleConfig);
          }
        }
      }
    }

    return result;
  }

  return {
    raw: rawConfig,
    isFileIgnored,
    isPrototypeZone,
    getRuleConfig,
    scoring,
    llm,
  };
}

/**
 * Merge a partial rule config into a required rule config.
 */
function mergeRuleConfig(
  base: RequiredRuleConfig,
  override: RuleConfig
): RequiredRuleConfig {
  return {
    enabled: override.enabled ?? base.enabled,
    level: override.level ?? base.level,
  };
}

/**
 * Load configuration from a YAML string (useful for testing, API usage, or GitHub integration).
 * This function does not touch the filesystem.
 *
 * @param yamlContent - The YAML content string
 * @returns LoadedConfig with resolved values and helper methods
 */
export function loadConfigFromString(yamlContent: string): LoadedConfig {
  let rawConfig: VibeScanConfig = { ...DEFAULT_CONFIG };

  try {
    const parsed = yaml.load(yamlContent) as Partial<VibeScanConfig> | null;

    if (parsed && typeof parsed === "object") {
      rawConfig = {
        version: parsed.version ?? 1,
        rules: parsed.rules ?? {},
        files: {
          ignore: parsed.files?.ignore ?? [],
          prototype_zone: parsed.files?.prototype_zone ?? [],
        },
        scoring: {
          high_risk_vibe_score:
            parsed.scoring?.high_risk_vibe_score ??
            DEFAULT_SCORING_CONFIG.high_risk_vibe_score,
          weight_multiplier:
            parsed.scoring?.weight_multiplier ??
            DEFAULT_SCORING_CONFIG.weight_multiplier,
        },
        llm: {
          enabled: parsed.llm?.enabled ?? DEFAULT_LLM_CONFIG.enabled,
          max_model_tokens:
            parsed.llm?.max_model_tokens ?? DEFAULT_LLM_CONFIG.max_model_tokens,
          temperature: parsed.llm?.temperature ?? DEFAULT_LLM_CONFIG.temperature,
          max_files: parsed.llm?.max_files ?? DEFAULT_LLM_CONFIG.max_files,
        },
        overrides: parsed.overrides ?? [],
      };
    }
  } catch (err) {
    console.warn(`[Config] Failed to parse YAML string:`, err);
    // Fall back to defaults
  }

  return buildLoadedConfig(rawConfig);
}

/**
 * Build a LoadedConfig from a raw VibeScanConfig.
 * Internal helper to avoid code duplication.
 */
function buildLoadedConfig(rawConfig: VibeScanConfig): LoadedConfig {
  // Build resolved scoring and LLM configs
  const scoring: RequiredScoringConfig = {
    high_risk_vibe_score:
      rawConfig.scoring?.high_risk_vibe_score ??
      DEFAULT_SCORING_CONFIG.high_risk_vibe_score,
    weight_multiplier:
      rawConfig.scoring?.weight_multiplier ??
      DEFAULT_SCORING_CONFIG.weight_multiplier,
  };

  const llm: RequiredLlmConfig = {
    enabled: rawConfig.llm?.enabled ?? DEFAULT_LLM_CONFIG.enabled,
    max_model_tokens:
      rawConfig.llm?.max_model_tokens ?? DEFAULT_LLM_CONFIG.max_model_tokens,
    temperature: rawConfig.llm?.temperature ?? DEFAULT_LLM_CONFIG.temperature,
    max_files: rawConfig.llm?.max_files ?? DEFAULT_LLM_CONFIG.max_files,
  };

  // Build ignore and prototype zone patterns
  const ignorePatterns = rawConfig.files?.ignore ?? [];
  const prototypeZonePatterns = rawConfig.files?.prototype_zone ?? [];

  /**
   * Check if a file matches any of the given glob patterns.
   */
  function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
    const normalizedPath = filePath.replace(/\\/g, "/");
    return patterns.some((pattern) =>
      minimatch(normalizedPath, pattern, { dot: true })
    );
  }

  /**
   * Check if a file should be ignored from analysis.
   */
  function isFileIgnored(filePath: string): boolean {
    return matchesAnyPattern(filePath, ignorePatterns);
  }

  /**
   * Check if a file is in a prototype zone.
   */
  function isPrototypeZone(filePath: string): boolean {
    return matchesAnyPattern(filePath, prototypeZonePatterns);
  }

  /**
   * Get the effective rule configuration for a rule and optional file path.
   */
  function getRuleConfig(ruleId: RuleId, filePath?: string): RequiredRuleConfig {
    // Start with defaults
    const defaultConfig = DEFAULT_RULE_CONFIG[ruleId];
    let result: RequiredRuleConfig = { ...defaultConfig };

    // Apply global rule config if present
    const globalRuleConfig = rawConfig.rules?.[ruleId];
    if (globalRuleConfig) {
      result = mergeRuleConfig(result, globalRuleConfig);
    }

    // Apply overrides for the file path
    if (filePath && rawConfig.overrides) {
      for (const override of rawConfig.overrides) {
        if (matchesAnyPattern(filePath, override.patterns)) {
          const overrideRuleConfig = override.rules[ruleId];
          if (overrideRuleConfig) {
            result = mergeRuleConfig(result, overrideRuleConfig);
          }
        }
      }
    }

    return result;
  }

  return {
    raw: rawConfig,
    isFileIgnored,
    isPrototypeZone,
    getRuleConfig,
    scoring,
    llm,
  };
}

/**
 * Create a default LoadedConfig without any file.
 * Useful for when no repo context is available.
 */
export function createDefaultConfig(): LoadedConfig {
  const rawConfig = { ...DEFAULT_CONFIG };

  const scoring: RequiredScoringConfig = { ...DEFAULT_SCORING_CONFIG };
  const llm: RequiredLlmConfig = { ...DEFAULT_LLM_CONFIG };

  function isFileIgnored(_filePath: string): boolean {
    return false;
  }

  function isPrototypeZone(_filePath: string): boolean {
    return false;
  }

  function getRuleConfig(ruleId: RuleId, _filePath?: string): RequiredRuleConfig {
    return { ...DEFAULT_RULE_CONFIG[ruleId] };
  }

  return {
    raw: rawConfig,
    isFileIgnored,
    isPrototypeZone,
    getRuleConfig,
    scoring,
    llm,
  };
}
