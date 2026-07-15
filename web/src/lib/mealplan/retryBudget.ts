// Epic E2 (F3) — shared retry budget spent across three action types, now
// weighted in points reflecting each type's real, live-confirmed
// Spoonacular cost, not a flat per-action count. A full recipe
// cascade/requery (claim-resolution's exhaustion retries, weekly
// reconciliation's slack-meal requery) costs ~5.6 real points
// (complexSearch's confirmed 2 + 0.06*resultCount formula at number=60);
// a snack add-on attempt (addon.ts) costs ~2 points (one ingredient search
// + one information call, 1.0pt flat each, both live-confirmed). Modeled
// here as a round 3:1 ratio (RECIPE_ACTION_COST/ADDON_ATTEMPT_COST) — an
// approximation of the real ~2.8:1, not meant to be exact.
//
// Originally a flat "3 actions total, not 3 each" budget (docs/
// PRD-MacroMap.md OQ7 + weekly reconciliation) from before add-ons
// existed. Widened here after a real generation hit that flat cap one
// add-on attempt short of closing its weekly gap (see addon.ts's git
// history) — the fix treats the original 3 as "3 recipe-requeries' worth
// of quota" (preserved exactly: 3 x RECIPE_ACTION_COST = 9) rather than
// "3 actions of any kind," so add-ons (the common path; exhaustion is
// rare) get proportionally more attempts for the same real quota spend.
//
// This 9-unit default was sized for a single WEEKLY reconciliation pass.
// When reconciliation later moved to per-day (orchestrate.ts), one budget
// this size was, for a while, shared across all 7 days plus exhaustion
// retries — under-provisioned for 7 independent passes instead of 1, and
// let day 0 (processed first) starve later days of any gap-closing help.
// Fixed (PRD F3 backlog item, closed July 2026): orchestrate.ts now calls
// createRetryBudget() fresh for each day (and separately for exhaustion),
// so every day gets this same 9-unit allowance rather than splitting one
// pool 7 ways.

export interface RetryBudget {
  remaining: number;
}

export const RECIPE_ACTION_COST = 3;
export const ADDON_ATTEMPT_COST = 1;

// AI composition fallback (aiMealComposition.ts, July 15 2026) — real cost
// is ~1 Claude call (a separate, non-Spoonacular cost not modeled here) +
// up to 4 ingredient lookups (protein/carb/fat/one fixed garnish) at the
// live-confirmed ~2pt flat rate each ≈ 6-8 Spoonacular points/attempt.
// Modeled at 5, between RECIPE_ACTION_COST and its real ~2x cost — an
// approximation, not meant to be exact, same honesty as the ratio above.
export const AI_COMPOSE_ACTION_COST = 5;

export function createRetryBudget(total = RECIPE_ACTION_COST * 3): RetryBudget {
  return { remaining: total };
}

// A separate, whole-generation (not per-day) budget for the AI composition
// fallback — it only ever applies to slots still genuinely blocked after
// the entire existing recipe-search + reconciliation pipeline has already
// run, which is rare (a handful of slots at most in real plans seen so
// far), so it doesn't need day-scoping the way reconciliation does. Sized
// to attempt up to 10 blocked slots in one generation — comfortably above
// every real blocked-count observed live so far (max 10), not an
// arbitrary round number.
export function createAiComposeBudget(): RetryBudget {
  return { remaining: AI_COMPOSE_ACTION_COST * 10 };
}

// Post-generation plan critique + repair (planCritic.ts/planRepair.ts,
// July 15 2026) — one Claude call to critique the whole week (a
// non-Spoonacular cost, not modeled here), then a real swap attempt
// (~RECIPE_ACTION_COST worth of Spoonacular cost) per flagged slot. Own
// whole-generation budget, separate from AI composition's, since this
// runs unconditionally on every generation with an API key configured
// rather than only for rare blocked slots — capped lower (5 slots) to
// bound cost on a pass that isn't solving a hard failure, just polishing
// an already-complete plan.
export function createPlanRepairBudget(): RetryBudget {
  return { remaining: RECIPE_ACTION_COST * 5 };
}

// No partial spend: returns false (and leaves remaining untouched) if the
// budget can't cover the full request.
export function trySpend(budget: RetryBudget, n = 1): boolean {
  if (budget.remaining < n) return false;
  budget.remaining -= n;
  return true;
}
