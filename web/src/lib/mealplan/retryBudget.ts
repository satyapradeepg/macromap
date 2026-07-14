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

export interface RetryBudget {
  remaining: number;
}

export const RECIPE_ACTION_COST = 3;
export const ADDON_ATTEMPT_COST = 1;

export function createRetryBudget(total = RECIPE_ACTION_COST * 3): RetryBudget {
  return { remaining: total };
}

// No partial spend: returns false (and leaves remaining untouched) if the
// budget can't cover the full request.
export function trySpend(budget: RetryBudget, n = 1): boolean {
  if (budget.remaining < n) return false;
  budget.remaining -= n;
  return true;
}
