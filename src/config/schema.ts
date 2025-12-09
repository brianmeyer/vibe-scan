/**
 * Configuration schema types for .vibescan.yml files.
 *
 * This module defines the structure of the configuration file
 * that can be placed in repository roots to customize Vibe Scan behavior.
 */

import { RuleConfig, RuleId, RuleOverride } from "../core/rules";

/**
 * Scoring configuration options.
 */
export interface VibeScanScoringConfig {
  /**
   * Score threshold below which a PR is marked as "high risk".
   * Default: 60
   */
  high_risk_vibe_score?: number;

  /**
   * Global multiplier applied to all rule weights.
   * Default: 1.0
   */
  weight_multiplier?: number;
}

/**
 * LLM analysis configuration options.
 */
export interface VibeScanLlmConfig {
  /**
   * Whether LLM analysis is enabled.
   * Default: true
   */
  enabled?: boolean;

  /**
   * Maximum tokens for LLM model responses.
   * Default: 4096
   */
  max_model_tokens?: number;

  /**
   * Temperature for LLM responses (0.0 - 1.0).
   * Default: 0.1
   */
  temperature?: number;

  /**
   * Maximum number of files to analyze with LLM.
   * Default: 50
   */
  max_files?: number;
}

/**
 * File filtering configuration options.
 */
export interface VibeScanFilesConfig {
  /**
   * Glob patterns for files to completely ignore from analysis.
   * Example: ["tests/**", "**\/*.spec.ts"]
   */
  ignore?: string[];

  /**
   * Glob patterns for files in "prototype zone" - still analyzed but
   * may receive different treatment in scoring/reporting.
   * Example: ["playground/**", "experiments/**"]
   */
  prototype_zone?: string[];
}

/**
 * Complete .vibescan.yml configuration schema.
 */
export interface VibeScanConfig {
  /**
   * Config file version. Currently only version 1 is supported.
   */
  version: number;

  /**
   * Rule-level configuration overrides.
   * Keys are RuleId strings, values are RuleConfig objects.
   */
  rules?: Partial<Record<RuleId, RuleConfig>>;

  /**
   * File filtering options.
   */
  files?: VibeScanFilesConfig;

  /**
   * Scoring configuration options.
   */
  scoring?: VibeScanScoringConfig;

  /**
   * LLM analysis configuration options.
   */
  llm?: VibeScanLlmConfig;

  /**
   * Path-specific rule overrides.
   * Applied in order; later overrides take precedence.
   */
  overrides?: RuleOverride[];
}

/**
 * Required/complete versions of optional config interfaces.
 */
export interface RequiredScoringConfig {
  high_risk_vibe_score: number;
  weight_multiplier: number;
}

export interface RequiredLlmConfig {
  enabled: boolean;
  max_model_tokens: number;
  temperature: number;
  max_files: number;
}

export interface RequiredFilesConfig {
  ignore: string[];
  prototype_zone: string[];
}

/**
 * Default values for scoring configuration.
 */
export const DEFAULT_SCORING_CONFIG: RequiredScoringConfig = {
  high_risk_vibe_score: 60,
  weight_multiplier: 1.0,
};

/**
 * Default values for LLM configuration.
 */
export const DEFAULT_LLM_CONFIG: RequiredLlmConfig = {
  enabled: true,
  max_model_tokens: 4096,
  temperature: 0.1,
  max_files: 50,
};

/**
 * Default values for files configuration.
 */
export const DEFAULT_FILES_CONFIG: RequiredFilesConfig = {
  ignore: [],
  prototype_zone: [],
};
