/**
 * GitHub Marketplace billing plans and tier management.
 *
 * This module handles:
 * - Plan storage and retrieval from Redis
 * - Tier-based feature limits (tokens, LLM access, etc.)
 * - Marketplace webhook event processing
 */

import { getRedisClient } from "./redis";

// ============================================================================
// Plan Types
// ============================================================================

/**
 * Available plan tiers.
 * Must match your GitHub Marketplace listing plan names.
 */
export type PlanTier = "free" | "pro" | "enterprise";

/**
 * Feature limits for each plan tier.
 */
export interface PlanLimits {
  /** Monthly LLM token quota */
  monthlyTokens: number;
  /** Whether LLM analysis is enabled */
  llmEnabled: boolean;
  /** Maximum files to analyze per PR */
  maxFilesPerPr: number;
  /** Whether baseline scanning is enabled */
  baselineEnabled: boolean;
}

/**
 * Plan configuration for each tier.
 *
 * ALPHA MODE: Free tier currently has full access for testing.
 * Production limits (to restore when monetizing):
 *   free: { monthlyTokens: 10_000, llmEnabled: false, maxFilesPerPr: 10, baselineEnabled: false }
 *   pro: { monthlyTokens: 100_000, ... }
 */
export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  // ALPHA: Free tier gets full access for testing (5M tokens)
  free: {
    monthlyTokens: 5_000_000,
    llmEnabled: true,
    maxFilesPerPr: 50,
    baselineEnabled: true,
  },
  pro: {
    monthlyTokens: 5_000_000,
    llmEnabled: true,
    maxFilesPerPr: 50,
    baselineEnabled: true,
  },
  enterprise: {
    monthlyTokens: 5_000_000,
    llmEnabled: true,
    maxFilesPerPr: 200,
    baselineEnabled: true,
  },
};

// ============================================================================
// Redis Key Helpers
// ============================================================================

/**
 * Get the Redis key for an installation's plan.
 */
function getPlanKey(installationId: number): string {
  return `vibe:plan:${installationId}`;
}

// ============================================================================
// Plan Storage
// ============================================================================

/**
 * Get the plan tier for an installation.
 * Returns "free" if no plan is stored or Redis is unavailable.
 */
export async function getInstallationPlan(installationId: number): Promise<PlanTier> {
  const redis = getRedisClient();
  if (!redis) {
    return "free";
  }

  try {
    const plan = await redis.get(getPlanKey(installationId));
    if (plan && isValidPlanTier(plan)) {
      return plan;
    }
    return "free";
  } catch (error) {
    console.error("[Plans] Error getting plan:", error instanceof Error ? error.message : "unknown");
    return "free";
  }
}

/**
 * Set the plan tier for an installation.
 */
export async function setInstallationPlan(installationId: number, plan: PlanTier): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    console.warn("[Plans] Redis not available, cannot store plan");
    return;
  }

  try {
    await redis.set(getPlanKey(installationId), plan);
    console.log(`[Plans] Set plan for installation ${installationId}: ${plan}`);
    // vibescale-ignore-next-line SILENT_ERROR - Fire-and-forget operation, default to free tier on failure
  } catch (error) {
    console.error("[Plans] Error setting plan:", error instanceof Error ? error.message : "unknown");
  }
}

/**
 * Remove the plan for an installation (on cancellation).
 */
export async function removeInstallationPlan(installationId: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    await redis.del(getPlanKey(installationId));
    console.log(`[Plans] Removed plan for installation ${installationId}`);
    // vibescale-ignore-next-line SILENT_ERROR - Fire-and-forget cleanup, failure is non-critical
  } catch (error) {
    console.error("[Plans] Error removing plan:", error instanceof Error ? error.message : "unknown");
  }
}

// ============================================================================
// Plan Limits
// ============================================================================

/**
 * Get the feature limits for an installation based on their plan.
 */
export async function getInstallationLimits(installationId: number): Promise<PlanLimits> {
  const plan = await getInstallationPlan(installationId);
  return PLAN_LIMITS[plan];
}

/**
 * Check if a plan tier string is valid.
 */
function isValidPlanTier(plan: string): plan is PlanTier {
  return plan === "free" || plan === "pro" || plan === "enterprise";
}

// ============================================================================
// Marketplace Webhook Handlers
// ============================================================================

/**
 * GitHub Marketplace purchase event payload.
 * This is a simplified type - actual payload has more fields.
 */
export interface MarketplacePurchasePayload {
  action: "purchased" | "cancelled" | "changed" | "pending_change" | "pending_change_cancelled";
  marketplace_purchase: {
    account: {
      id: number;
      login: string;
      type: "Organization" | "User";
    };
    plan: {
      id: number;
      name: string;
      description: string;
      monthly_price_in_cents: number;
      yearly_price_in_cents: number;
      price_model: "FREE" | "FLAT_RATE" | "PER_UNIT";
      unit_name: string | null;
      bullets: string[];
    };
    billing_cycle: "monthly" | "yearly";
    unit_count: number;
    on_free_trial: boolean;
    free_trial_ends_on: string | null;
  };
  previous_marketplace_purchase?: {
    plan: {
      id: number;
      name: string;
    };
  };
  sender: {
    login: string;
    id: number;
  };
}

/**
 * Map a GitHub Marketplace plan name to our internal tier.
 * Adjust these mappings to match your actual plan names in the Marketplace.
 */
function mapPlanNameToTier(planName: string): PlanTier {
  const normalizedName = planName.toLowerCase().trim();

  if (normalizedName.includes("enterprise") || normalizedName.includes("team")) {
    return "enterprise";
  }
  if (normalizedName.includes("pro") || normalizedName.includes("starter")) {
    return "pro";
  }
  return "free";
}

/**
 * Handle a marketplace_purchase webhook event.
 */
export async function handleMarketplacePurchase(payload: MarketplacePurchasePayload): Promise<void> {
  const { action, marketplace_purchase } = payload;
  const accountId = marketplace_purchase.account.id;
  const accountLogin = marketplace_purchase.account.login;
  const planName = marketplace_purchase.plan.name;

  console.log(`[Marketplace] Received ${action} event for ${accountLogin} (${accountId}), plan: ${planName}`);

  switch (action) {
    case "purchased":
    case "changed": {
      const tier = mapPlanNameToTier(planName);
      await setInstallationPlan(accountId, tier);
      console.log(`[Marketplace] ${accountLogin} subscribed to ${tier} plan`);
      break;
    }

    case "cancelled": {
      await removeInstallationPlan(accountId);
      console.log(`[Marketplace] ${accountLogin} cancelled subscription`);
      break;
    }

    case "pending_change": {
      // User requested a plan change, will take effect at end of billing cycle
      const newPlanName = payload.marketplace_purchase.plan.name;
      console.log(`[Marketplace] ${accountLogin} has pending change to ${newPlanName}`);
      // Optionally: store pending change info
      break;
    }

    case "pending_change_cancelled": {
      console.log(`[Marketplace] ${accountLogin} cancelled pending plan change`);
      break;
    }

    default:
      console.warn(`[Marketplace] Unknown action: ${action}`);
  }
}
