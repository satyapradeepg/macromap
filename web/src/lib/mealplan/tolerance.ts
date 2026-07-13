// Epic E2 (F3) — OQ2 macro tolerance cascade. Widens ±10% -> ±20% -> ±30%
// on zero results. Applied to protein + calories as the actual Spoonacular
// query filter (verified live: adding carbs/fat as a HARD filter there
// starves the shared 21-slot pool badly — as few as 1/2/14 matches at
// p10/p20/p30 for a real profile, far short of 21). Carb/fat bounds are
// still computed here and used as a local ranking PREFERENCE (see
// ranking.ts's macroCompliant) over data already returned by the same
// protein/calories-filtered query — no extra API calls needed.

export type ToleranceTier = "p10" | "p20" | "p30";
export const TOLERANCE_TIERS: readonly ToleranceTier[] = ["p10", "p20", "p30"];
export const TOLERANCE_PCT: Record<ToleranceTier, number> = {
  p10: 0.1,
  p20: 0.2,
  p30: 0.3,
};

// minCarbs/maxCarbs/minFat/maxFat are NOT sent to Spoonacular (see header) —
// present here purely for the local macroCompliant preference check.
export interface MacroBounds {
  minProtein: number;
  maxProtein: number;
  minCalories: number;
  maxCalories: number;
  minCarbs: number;
  maxCarbs: number;
  minFat: number;
  maxFat: number;
}

export function boundsForTier(
  target: { proteinG: number; calories: number; carbsG: number; fatG: number },
  tier: ToleranceTier,
): MacroBounds {
  const pct = TOLERANCE_PCT[tier];
  return {
    minProtein: target.proteinG * (1 - pct),
    maxProtein: target.proteinG * (1 + pct),
    minCalories: target.calories * (1 - pct),
    maxCalories: target.calories * (1 + pct),
    minCarbs: target.carbsG * (1 - pct),
    maxCarbs: target.carbsG * (1 + pct),
    minFat: target.fatG * (1 - pct),
    maxFat: target.fatG * (1 + pct),
  };
}

// Which tier a candidate's actual macros truly fall into against a target —
// null if outside even p30. Needed because weekly reconciliation searches
// with intentionally nudged bounds (see reconciliation.ts's nudgedBounds),
// so a candidate it picks may land outside the tier a slot was originally
// claimed at; the persisted label must reflect the real deviation, not
// whatever tier the slot happened to carry before the swap. Deliberately
// protein/calories only (unrelated to carb/fat preference) — this drives
// the user-facing "closest match" label, which is about the primary macros.
export function classifyTier(
  candidate: { proteinG: number; caloriesKcal: number },
  target: { proteinG: number; calories: number },
): ToleranceTier | null {
  for (const tier of TOLERANCE_TIERS) {
    const pct = TOLERANCE_PCT[tier];
    const minProtein = target.proteinG * (1 - pct);
    const maxProtein = target.proteinG * (1 + pct);
    const minCalories = target.calories * (1 - pct);
    const maxCalories = target.calories * (1 + pct);
    if (
      candidate.proteinG >= minProtein &&
      candidate.proteinG <= maxProtein &&
      candidate.caloriesKcal >= minCalories &&
      candidate.caloriesKcal <= maxCalories
    ) {
      return tier;
    }
  }
  return null;
}
