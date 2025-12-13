/**
 * GitHub integration module.
 *
 * This module provides GitHub webhook handling, PR analysis,
 * and issue creation for Vibe Check.
 */

// Re-export main webhook components
export { webhooks, registerEventHandlers } from "./webhooks";

// Re-export API handler
export { analyzeForApi } from "./api";

// Re-export types for external use
export type { ApiAnalysisResult } from "./types";
