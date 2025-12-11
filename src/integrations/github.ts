/**
 * GitHub integration module.
 *
 * This file re-exports from the modular github/ directory for backwards compatibility.
 * New code should import from "./github" or "./github/specific-module".
 */

export { webhooks, registerEventHandlers, analyzeForApi } from "./github/index";
export type { ApiAnalysisResult } from "./github/index";
