/**
 * Rule types and default configurations for Vibe Scan.
 *
 * This module defines the canonical list of rule IDs, severity levels,
 * and default configurations for all static analysis rules.
 */

/**
 * All supported rule IDs in Vibe Scan.
 * DO NOT rename existing IDs - only extend.
 */
export type RuleId =
  // Error handling rules
  | "UNSAFE_IO"
  | "SILENT_ERROR"
  | "ASYNC_MISUSE"
  // Scaling rules
  | "UNBOUNDED_QUERY"
  | "UNBOUNDED_COLLECTION_PROCESSING"
  | "MISSING_BATCHING"
  | "NO_CACHING"
  | "MEMORY_RISK"
  | "LOOPED_IO"
  | "BLOCKING_OPERATION"
  // Concurrency rules
  | "SHARED_FILE_WRITE"
  | "RETRY_STORM_RISK"
  | "BUSY_WAIT_OR_TIGHT_LOOP"
  | "CHECK_THEN_ACT_RACE"
  | "GLOBAL_MUTATION"
  // Data integrity rules
  | "UNVALIDATED_INPUT"
  | "DATA_SHAPE_ASSUMPTION"
  | "MIXED_RESPONSE_SHAPES"
  | "HARDCODED_SECRET"
  // Code quality rules
  | "TEMPORARY_HACK"
  | "CONSOLE_DEBUG"
  // Architecture rules
  | "STATEFUL_SERVICE"
  | "PROTOTYPE_INFRA";

/**
 * Rule severity levels.
 * - error: Critical issue that must be fixed before production
 * - warning: Should be fixed, but not blocking
 * - info: Advisory, nice to fix
 * - off: Rule is disabled
 */
export type RuleLevel = "error" | "warning" | "info" | "off";

/**
 * Configuration for a single rule.
 */
export interface RuleConfig {
  enabled?: boolean;
  level?: RuleLevel;
}

/**
 * A rule override that applies to specific file patterns.
 */
export interface RuleOverride {
  patterns: string[];
  rules: Partial<Record<RuleId, RuleConfig>>;
}

/**
 * Complete (required) rule configuration.
 */
export interface RequiredRuleConfig {
  enabled: boolean;
  level: RuleLevel;
}

/**
 * Default configuration for all rules.
 *
 * Scaling/availability/concurrency risks are "error" level.
 * Softer style rules are "warning" or "info" level.
 */
export const DEFAULT_RULE_CONFIG: Record<RuleId, RequiredRuleConfig> = {
  // Error handling rules - high severity
  UNSAFE_IO: { enabled: true, level: "error" },
  SILENT_ERROR: { enabled: true, level: "error" },
  ASYNC_MISUSE: { enabled: true, level: "warning" },

  // Scaling rules - high severity
  UNBOUNDED_QUERY: { enabled: true, level: "error" },
  UNBOUNDED_COLLECTION_PROCESSING: { enabled: true, level: "error" },
  MISSING_BATCHING: { enabled: true, level: "error" },
  NO_CACHING: { enabled: true, level: "warning" },
  MEMORY_RISK: { enabled: true, level: "error" },
  LOOPED_IO: { enabled: true, level: "error" },
  BLOCKING_OPERATION: { enabled: true, level: "warning" },

  // Concurrency rules - high severity
  SHARED_FILE_WRITE: { enabled: true, level: "error" },
  RETRY_STORM_RISK: { enabled: true, level: "error" },
  BUSY_WAIT_OR_TIGHT_LOOP: { enabled: true, level: "error" },
  CHECK_THEN_ACT_RACE: { enabled: true, level: "warning" },
  GLOBAL_MUTATION: { enabled: true, level: "error" },

  // Data integrity rules - medium severity
  UNVALIDATED_INPUT: { enabled: true, level: "warning" },
  DATA_SHAPE_ASSUMPTION: { enabled: true, level: "warning" },
  MIXED_RESPONSE_SHAPES: { enabled: true, level: "warning" },
  HARDCODED_SECRET: { enabled: true, level: "error" },

  // Code quality rules - lower severity
  TEMPORARY_HACK: { enabled: true, level: "warning" },
  CONSOLE_DEBUG: { enabled: true, level: "info" },

  // Architecture rules - critical for horizontal scaling
  STATEFUL_SERVICE: { enabled: true, level: "error" },
  PROTOTYPE_INFRA: { enabled: true, level: "error" },
};

/**
 * List of all rule IDs for iteration.
 */
export const ALL_RULE_IDS: RuleId[] = Object.keys(DEFAULT_RULE_CONFIG) as RuleId[];

/**
 * Check if a string is a valid RuleId.
 */
export function isValidRuleId(id: string): id is RuleId {
  return Object.prototype.hasOwnProperty.call(DEFAULT_RULE_CONFIG, id);
}

/**
 * Categorization of rules for architecture risk summary.
 */
export const RULE_CATEGORIES = {
  scaling: [
    "UNBOUNDED_QUERY",
    "UNBOUNDED_COLLECTION_PROCESSING",
    "MISSING_BATCHING",
    "NO_CACHING",
    "MEMORY_RISK",
    "LOOPED_IO",
    "BLOCKING_OPERATION",
    "STATEFUL_SERVICE",
  ] as RuleId[],
  concurrency: [
    "SHARED_FILE_WRITE",
    "RETRY_STORM_RISK",
    "BUSY_WAIT_OR_TIGHT_LOOP",
    "CHECK_THEN_ACT_RACE",
    "GLOBAL_MUTATION",
  ] as RuleId[],
  errorHandling: ["UNSAFE_IO", "SILENT_ERROR", "ASYNC_MISUSE"] as RuleId[],
  dataIntegrity: [
    "UNVALIDATED_INPUT",
    "DATA_SHAPE_ASSUMPTION",
    "MIXED_RESPONSE_SHAPES",
    "HARDCODED_SECRET",
  ] as RuleId[],
  architecture: [
    "STATEFUL_SERVICE",
    "PROTOTYPE_INFRA",
  ] as RuleId[],
} as const;
