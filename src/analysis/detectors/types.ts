/**
 * Types for the static analyzer detectors.
 */

import { RuleLevel } from "../rules";

export type Severity = "low" | "medium" | "high";

export interface Finding {
  file: string;
  line?: number;
  severity: Severity;
  kind: string;
  message: string;
  snippet?: string;
  /** The effective rule level from config (error/warning/info). */
  level?: RuleLevel;
  /** Whether this file is in a prototype zone. */
  isPrototypeZone?: boolean;
}
