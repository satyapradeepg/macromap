// Epic E2 (F3) — reconciliation pass. Per-meal tolerance (OQ2, ±10-30%)
// doesn't guarantee a larger aggregate lands on target, so after a set of
// slots is claimed, sum actuals and compare to a tighter ±5% band; re-query
// up to the shared retry budget's remaining slots with the most slack
// (docs/PRD-MacroMap.md OQ2 extended).
//
// Originally weekly-only (summed all 21 slots once). Reworked to run
// per-day instead (orchestrate.ts loops days 0-6, calling these same
// functions with just that day's 3 slots and the daily target) — a plan
// can look fine on a whole-week average while individual days swing
// wildly, and Prospre-style plans reconcile at daily granularity. The
// functions below were already generic over whatever MacroTargets/
// ClaimedSlot[] they're given, so no math changed — only what orchestrate.ts
// passes in. Renamed weeklyBand -> toleranceBand accordingly (band math is
// identical at either granularity).

import type { ClaimedSlot } from "./claim";
import type { MealSlotId, MealType } from "./targets";
import type { MacroTargets } from "./targets";
import type { MacroBounds } from "./tolerance";

const BAND_PCT = 0.05;

export interface MacroBand {
  calories: { min: number; max: number };
  proteinG: { min: number; max: number };
  carbsG: { min: number; max: number };
  fatG: { min: number; max: number };
}

export function toleranceBand(target: MacroTargets): MacroBand {
  const band = (value: number) => ({
    min: value * (1 - BAND_PCT),
    max: value * (1 + BAND_PCT),
  });
  return {
    calories: band(target.calories),
    proteinG: band(target.proteinG),
    carbsG: band(target.carbsG),
    fatG: band(target.fatG),
  };
}

// 1 serving per meal-slot (F3 doesn't model multi-serving eating — that's
// OQ4/F4's grocery-quantity scaling concern, not the nutrition sum).
export function sumActuals(claimed: ClaimedSlot[]): MacroTargets {
  return claimed.reduce(
    (sum, slot) => ({
      calories: sum.calories + slot.candidate.caloriesKcal,
      proteinG: sum.proteinG + slot.candidate.proteinG,
      carbsG: sum.carbsG + slot.candidate.carbsG,
      fatG: sum.fatG + slot.candidate.fatG,
    }),
    { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  );
}

export type MacroKey = "calories" | "proteinG" | "carbsG" | "fatG";
const MACRO_KEYS: readonly MacroKey[] = ["calories", "proteinG", "carbsG", "fatG"];

export function outsideMacros(actual: MacroTargets, band: MacroBand): MacroKey[] {
  return MACRO_KEYS.filter((key) => actual[key] < band[key].min || actual[key] > band[key].max);
}

export interface MacroGapDirection {
  macro: MacroKey;
  direction: "increase" | "decrease"; // which way the weekly actual needs to move
  overshootPct: number; // |actual - nearest band edge| / target, for picking a dominant direction
}

export function macroGapDirections(actual: MacroTargets, band: MacroBand): MacroGapDirection[] {
  const gaps: MacroGapDirection[] = [];
  for (const macro of MACRO_KEYS) {
    if (actual[macro] > band[macro].max) {
      gaps.push({
        macro,
        direction: "decrease",
        overshootPct: (actual[macro] - band[macro].max) / band[macro].max,
      });
    } else if (actual[macro] < band[macro].min) {
      gaps.push({
        macro,
        direction: "increase",
        overshootPct: (band[macro].min - actual[macro]) / band[macro].min,
      });
    }
  }
  return gaps;
}

export function isWithinBand(actual: MacroTargets, band: MacroBand): boolean {
  return macroGapDirections(actual, band).length === 0;
}

// A single re-query can only nudge protein+calories bounds one way at a
// time (see nudgedBounds) — if multiple macros are out of band in opposite
// directions, pick the one with the largest relative overshoot to drive
// the nudge direction for this reconciliation round.
export function dominantDirection(gaps: MacroGapDirection[]): "increase" | "decrease" | null {
  if (gaps.length === 0) return null;
  return [...gaps].sort((a, b) => b.overshootPct - a.overshootPct)[0].direction;
}

// F3 snack/add-on gap-closer: an add-on can only ever ADD macros, so it's
// only useful for "increase" gaps (weekly actual too low) — a "decrease"
// gap (too high) can't be helped by adding food, only by swapping to a
// leaner recipe (the existing slack-meal requery). Returns the single
// largest-overshoot "increase" gap to target, or null if every current gap
// is a "decrease" (add-on phase should be skipped entirely for this round).
export function dominantIncreaseGap(gaps: MacroGapDirection[]): MacroGapDirection | null {
  const increaseGaps = gaps.filter((g) => g.direction === "increase");
  if (increaseGaps.length === 0) return null;
  return [...increaseGaps].sort((a, b) => b.overshootPct - a.overshootPct)[0];
}

// Up to `max` slots with the most "slack" — furthest from their own
// per-meal-type target (breakfast/lunch/dinner now have different targets,
// see targets.ts's MEAL_TYPE_SHARE), in the direction that would help move
// the day's total toward its band for the given gap directions.
export function pickSlackSlots(
  claimed: ClaimedSlot[],
  mealTypeTargets: Record<MealType, MacroTargets>,
  gaps: MacroGapDirection[],
  max = 3,
): MealSlotId[] {
  if (gaps.length === 0) return [];

  const candidateValue = (candidate: ClaimedSlot["candidate"]): Record<MacroKey, number> => ({
    calories: candidate.caloriesKcal,
    proteinG: candidate.proteinG,
    carbsG: candidate.carbsG,
    fatG: candidate.fatG,
  });

  const scored = claimed.map((slot) => {
    const values = candidateValue(slot.candidate);
    const target = mealTypeTargets[slot.slotId.mealType];
    const perMealValue: Record<MacroKey, number> = {
      calories: target.calories,
      proteinG: target.proteinG,
      carbsG: target.carbsG,
      fatG: target.fatG,
    };
    // Slack is positive when this slot's actual sits on the side of its own
    // per-meal-type target that helps move the day's total in the needed
    // direction (e.g. day too high -> a slot already above its own target
    // has room to be swapped down).
    let slack = 0;
    for (const gap of gaps) {
      const deviation = values[gap.macro] - perMealValue[gap.macro];
      slack += gap.direction === "decrease" ? deviation : -deviation;
    }
    return { slot, slack };
  });

  return scored
    .sort((a, b) => b.slack - a.slack)
    .slice(0, max)
    .map((s) => s.slot.slotId);
}

// Single targeted re-fetch (not a fresh 3-tier cascade) — re-running the
// full cascade per slack slot could burn the whole retry budget on
// tier-widening alone. Nudges all four macros in the same direction (not
// just protein/calories) so the carb/fat compliance preference (see
// ranking.ts's macroCompliant) also leans the right way during this
// targeted retry, not just the Spoonacular-side protein/calorie query.
export function nudgedBounds(
  perMealTargetForSlot: MacroTargets,
  direction: "increase" | "decrease",
  pct = 0.15,
): MacroBounds {
  const multiplier = direction === "increase" ? 1 + pct : 1 - pct;
  const nudged = (value: number) => value * multiplier;
  const bound = (value: number) => ({
    min: Math.min(value, nudged(value)),
    max: Math.max(value, nudged(value)),
  });
  const protein = bound(perMealTargetForSlot.proteinG);
  const calories = bound(perMealTargetForSlot.calories);
  const carbs = bound(perMealTargetForSlot.carbsG);
  const fat = bound(perMealTargetForSlot.fatG);
  return {
    minProtein: protein.min,
    maxProtein: protein.max,
    minCalories: calories.min,
    maxCalories: calories.max,
    minCarbs: carbs.min,
    maxCarbs: carbs.max,
    minFat: fat.min,
    maxFat: fat.max,
  };
}
