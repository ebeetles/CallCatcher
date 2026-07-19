import { usage } from "./db.ts";
import type { TenantRecord } from "./types.ts";

/**
 * Subscription tiers. Prices/limits are config — edit here (and mirror the
 * price ids in Stripe via STRIPE_PRICE_* envs). Enforcement is hard-cap in v1:
 * businesses over the cap can't be created (402), inbound calls past the
 * included minutes get a polite "unavailable" message until the month rolls
 * over or the tenant upgrades.
 */

export interface Plan {
  id: string;
  label: string;
  priceUsd: number;
  maxBusinesses: number;
  /** Included call minutes per calendar month (phone + web test calls). */
  includedMinutes: number;
  /** May receptionists use premium ElevenLabs voices? */
  elevenlabs: boolean;
  blurb: string;
}

export const PLANS: Record<string, Plan> = {
  trial: {
    id: "trial",
    label: "Free trial",
    priceUsd: 0,
    maxBusinesses: 1,
    includedMinutes: 60,
    elevenlabs: true,
    blurb: "14 days, every feature unlocked. Build one receptionist and put it on a real number.",
  },
  starter: {
    id: "starter",
    label: "Starter",
    priceUsd: 49,
    maxBusinesses: 1,
    includedMinutes: 300,
    elevenlabs: false,
    blurb: "One client on a real phone line with call logs, inbox, and SMS notifications.",
  },
  pro: {
    id: "pro",
    label: "Pro",
    priceUsd: 149,
    maxBusinesses: 5,
    includedMinutes: 1500,
    elevenlabs: true,
    blurb: "Up to five clients, premium ElevenLabs voices, and room to grow your roster.",
  },
  scale: {
    id: "scale",
    label: "Scale",
    priceUsd: 399,
    maxBusinesses: 15,
    includedMinutes: 6000,
    elevenlabs: true,
    blurb: "Fifteen clients and serious call volume for an agency in full swing.",
  },
  dev: {
    id: "dev",
    label: "Dev",
    priceUsd: 0,
    maxBusinesses: Number.POSITIVE_INFINITY,
    includedMinutes: Number.POSITIVE_INFINITY,
    elevenlabs: true,
    blurb: "Internal platform tenant — no limits.",
  },
};

/** Tiers shown on pricing pages / upgrade grids (in display order). */
export const PUBLIC_PLAN_IDS = ["starter", "pro", "scale"] as const;

export type BlockedReason = "trial_expired" | "past_due" | "canceled" | "suspended";

export interface Entitlements {
  plan: Plan;
  /** May the tenant use the product at all (dashboards keep working; calls/creation don't). */
  active: boolean;
  blockedReason?: BlockedReason;
  minutesUsed: number;
  minutesExhausted: boolean;
  trialDaysLeft?: number;
}

export function entitlements(tenant: TenantRecord): Entitlements {
  const plan = PLANS[tenant.plan] ?? PLANS.trial;
  let active = true;
  let blockedReason: BlockedReason | undefined;

  if (tenant.planStatus === "canceled") {
    active = false;
    blockedReason = "canceled";
  } else if (tenant.planStatus === "suspended") {
    active = false;
    blockedReason = "suspended";
  }
  // past_due keeps working (Stripe retries); Stripe's subscription cancellation
  // webhook flips it to canceled if dunning fails for good.

  let trialDaysLeft: number | undefined;
  if (plan.id === "trial" && tenant.trialEndsAt) {
    const msLeft = new Date(tenant.trialEndsAt).getTime() - Date.now();
    trialDaysLeft = Math.max(0, Math.ceil(msLeft / 86400_000));
    if (msLeft <= 0 && active) {
      active = false;
      blockedReason = "trial_expired";
    }
  }

  const minutesUsed = Math.round(usage.month(tenant.id).seconds / 60);
  return {
    plan,
    active,
    blockedReason,
    minutesUsed,
    minutesExhausted: minutesUsed >= plan.includedMinutes,
    trialDaysLeft,
  };
}

/** Compact summary embedded in /api/status for banners/paywalls. */
export function entitlementSummary(tenant: TenantRecord) {
  const e = entitlements(tenant);
  return {
    active: e.active,
    blockedReason: e.blockedReason,
    minutesUsed: e.minutesUsed,
    includedMinutes: e.plan.includedMinutes === Number.POSITIVE_INFINITY ? null : e.plan.includedMinutes,
    minutesExhausted: e.minutesExhausted,
    maxBusinesses: e.plan.maxBusinesses === Number.POSITIVE_INFINITY ? null : e.plan.maxBusinesses,
    trialDaysLeft: e.trialDaysLeft,
  };
}
