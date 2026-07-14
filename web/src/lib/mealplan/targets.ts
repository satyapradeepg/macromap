// Epic E2 (F3 meal plan generation) — docs/PRD-MacroMap.md Section 7.3, OQ7.
// Slot enumeration and per-meal/weekly target math. Pure, no side effects.

export type MealType = "breakfast" | "lunch" | "dinner";
export const MEAL_TYPES: readonly MealType[] = ["breakfast", "lunch", "dinner"];
export const DAYS_PER_WEEK = 7;
export const MEALS_PER_WEEK = DAYS_PER_WEEK * MEAL_TYPES.length; // 21

export interface MealSlotId {
  dayIndex: number; // 0-6
  mealType: MealType;
}

export interface MacroTargets {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

// Fixed claim-resolution walk order (OQ7): Day1 Breakfast .. Day7 Dinner.
export function allSlotIds(): MealSlotId[] {
  const slots: MealSlotId[] = [];
  for (let dayIndex = 0; dayIndex < DAYS_PER_WEEK; dayIndex++) {
    for (const mealType of MEAL_TYPES) {
      slots.push({ dayIndex, mealType });
    }
  }
  return slots;
}

export function slotKey(slot: MealSlotId): string {
  return `${slot.dayIndex}-${slot.mealType}`;
}

// Meal-type realism (Epic E2 rework) — maps our internal MealType to
// Spoonacular's `type` complexSearch param, live-confirmed (July 2026) to
// return genuinely meal-appropriate results (type=breakfast -> smoothies/
// frittatas, type=main course -> soups/stews), not just a label. Lunch and
// dinner share "main course" rather than getting distinct types — nothing
// in Spoonacular's vocabulary meaningfully separates them, and splitting
// further would fragment the shared query pool without a real benefit.
export function mealTypeToSpoonacularType(mealType: MealType): string {
  return mealType === "breakfast" ? "breakfast" : "main course";
}

// Realistic per-meal-type share of the daily total (Epic E2 rework),
// replacing an even 1/3-1/3-1/3 split. Not a dietitian-prescribed formula —
// there isn't one; total daily macros and reasonably even protein
// distribution across meals matter far more than exact per-meal
// percentages (see docs/PRD-MacroMap.md realism discussion). This is a
// sensible default matching common eating patterns (lighter breakfast,
// bigger lunch/dinner), and it fixes a real bug: an even 1/3 split gave
// breakfast the same protein/calorie target as lunch/dinner, but live
// testing found real breakfast recipes run far lighter than that for a
// high-protein profile — as few as 4 real Spoonacular matches, causing
// blocked slots. Applied uniformly across all 4 macros (not just
// calories) — treating protein differently (e.g. an even 1/3 split) was
// considered and rejected: it would make breakfast's protein *density*
// higher than almost any real breakfast recipe, reintroducing the same
// scarcity problem from the other direction. See checkProteinFloor below
// for the actual protein-distribution safeguard instead.
export const MEAL_TYPE_SHARE: Record<MealType, number> = {
  breakfast: 0.2,
  lunch: 0.4,
  dinner: 0.4,
};

export function perMealTarget(daily: MacroTargets, mealType: MealType): MacroTargets {
  const share = MEAL_TYPE_SHARE[mealType];
  return {
    calories: daily.calories * share,
    proteinG: daily.proteinG * share,
    carbsG: daily.carbsG * share,
    fatG: daily.fatG * share,
  };
}

// Convenience for building a lookup used once per generation (orchestrate.ts)
// instead of recomputing perMealTarget per slot.
export function allMealTypeTargets(daily: MacroTargets): Record<MealType, MacroTargets> {
  return Object.fromEntries(MEAL_TYPES.map((mealType) => [mealType, perMealTarget(daily, mealType)])) as Record<
    MealType,
    MacroTargets
  >;
}

// Protein-distribution safeguard (Epic E2 rework) — the actual
// evidence-based practice here isn't a fixed per-meal percentage, it's
// that muscle protein synthesis has a per-sitting ceiling, so protein
// shouldn't be backloaded into one meal while another gets almost none.
// Monitoring-only: flags days where any meal falls below a loose 12% of
// the daily protein target, rather than forcing ranking to redistribute
// (which risks reintroducing the exact corpus-scarcity problem the
// MEAL_TYPE_SHARE split above was built to avoid — see its comment).
export const PROTEIN_FLOOR_FRACTION = 0.12;

export function proteinFloorViolations(
  dailyProteinTarget: number,
  mealProteinValues: Array<{ mealType: MealType; proteinG: number }>,
): MealType[] {
  const floor = dailyProteinTarget * PROTEIN_FLOOR_FRACTION;
  return mealProteinValues.filter((m) => m.proteinG < floor).map((m) => m.mealType);
}

export function weeklyTarget(daily: MacroTargets): MacroTargets {
  return {
    calories: daily.calories * DAYS_PER_WEEK,
    proteinG: daily.proteinG * DAYS_PER_WEEK,
    carbsG: daily.carbsG * DAYS_PER_WEEK,
    fatG: daily.fatG * DAYS_PER_WEEK,
  };
}
