// Epic E2 (F3 meal plan generation) — docs/PRD-MacroMap.md Section 7.3, OQ7.
// Slot enumeration and per-meal/weekly target math. Pure, no side effects.

// snack1/snack2 added alongside the real snack-slot rework — Prospre-style
// plans include two real snacks/day, not just an occasional reconciliation
// patch (see addon.ts's SlotAddon, a separate, smaller mechanism still used
// for topping up any meal/snack when the day's aggregate falls short).
export type MealType = "breakfast" | "lunch" | "dinner" | "snack1" | "snack2";
export const MEAL_TYPES: readonly MealType[] = ["breakfast", "lunch", "dinner", "snack1", "snack2"];
export const DAYS_PER_WEEK = 7;
export const MEALS_PER_WEEK = DAYS_PER_WEEK * MEAL_TYPES.length; // 35

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

// Which generation mechanism a slot uses — recipe search (breakfast/lunch/
// dinner) vs ingredient composition (snacks). Live-tested (July 2026):
// Spoonacular's type=snack recipe corpus is dominated by low-protein soups/
// dips/salads (2-15g protein) and has as few as 8 real matches at
// Prospre-scale snack targets (300+ cal, 20-36g protein) — recipe search is
// the wrong tool for snacks. Composing 2-3 whole-food ingredients instead
// (snackComposition.ts) has no corpus-scarcity ceiling.
export type SlotMechanism = "recipe" | "composed";
const SLOT_MECHANISM: Record<MealType, SlotMechanism> = {
  breakfast: "recipe",
  lunch: "recipe",
  dinner: "recipe",
  snack1: "composed",
  snack2: "composed",
};
export function slotMechanism(mealType: MealType): SlotMechanism {
  return SLOT_MECHANISM[mealType];
}

// Meal-type realism (Epic E2 rework) — maps our internal MealType to
// Spoonacular's `type` complexSearch param, live-confirmed (July 2026) to
// return genuinely meal-appropriate results (type=breakfast -> smoothies/
// frittatas, type=main course -> soups/stews), not just a label. Lunch and
// dinner share "main course" rather than getting distinct types — nothing
// in Spoonacular's vocabulary meaningfully separates them, and splitting
// further would fragment the shared query pool without a real benefit.
// Only meaningful for "recipe"-mechanism slots — throws for snacks rather
// than silently querying Spoonacular's thin snack corpus.
export function mealTypeToSpoonacularType(mealType: MealType): string {
  if (SLOT_MECHANISM[mealType] === "composed") {
    throw new Error(`mealTypeToSpoonacularType called for a composed-mechanism slot: ${mealType}`);
  }
  return mealType === "breakfast" ? "breakfast" : "main course";
}

// Realistic per-meal-type share of the daily total (Epic E2 rework),
// replacing an even 1/3-1/3-1/3 split. Not a dietitian-prescribed formula —
// there isn't one; total daily macros and reasonably even protein
// distribution across meals matter far more than exact per-meal
// percentages (see docs/PRD-MacroMap.md realism discussion). This is a
// sensible default matching common eating patterns (lighter breakfast,
// biggest lunch, dinner smaller than lunch, two snacks splitting the
// remainder) — derived from a real competitor's (Prospre) sample data,
// rounded to clean numbers, not fitted precisely to 2 sample days. Applied
// uniformly across all 4 macros (not just calories) — treating protein
// differently (e.g. an even split) was considered and rejected: it would
// make breakfast's protein *density* higher than almost any real breakfast
// recipe, reintroducing the exact scarcity problem this split fixes (live
// testing found an even 1/3 split gave breakfast as few as 4 real
// Spoonacular matches, causing blocked slots). See proteinFloorViolations
// below for the actual protein-distribution safeguard instead, and
// CALORIE_BOUNDS below for why the share alone isn't sufficient at extreme
// TDEE inputs.
export const MEAL_TYPE_SHARE: Record<MealType, number> = {
  breakfast: 0.2,
  lunch: 0.32,
  dinner: 0.16,
  snack1: 0.16,
  snack2: 0.16,
};

// Absolute sanity bounds per slot, on top of the percentage share above —
// a real, live-confirmed gap: at this app's own allowed input extremes
// (13-100yo, 30-300kg), the percentage split alone produces unrealistic
// single-meal sizes (e.g. a 150kg/200cm/25yo very-active bulker's 32%
// lunch share is ~1815 kcal in one sitting; a 40kg/150cm/70yo sedentary
// cutter's 20% breakfast share is ~198 kcal, too small to reliably match
// real breakfast recipes). Clamped and rescaled proportionally (same
// macro ratio the percentage split implied, just at a realistic absolute
// size) — for the rare profile this triggers on, the day's real total
// will legitimately fall outside the daily band, and reconciliation
// (orchestrate.ts) honestly reports that rather than recommending an
// unrealistic single meal.
const CALORIE_BOUNDS: Record<SlotMechanism, { min: number; max: number }> = {
  recipe: { min: 250, max: 1200 },
  composed: { min: 100, max: 500 },
};

export function perMealTarget(daily: MacroTargets, mealType: MealType): MacroTargets {
  const share = MEAL_TYPE_SHARE[mealType];
  const raw: MacroTargets = {
    calories: daily.calories * share,
    proteinG: daily.proteinG * share,
    carbsG: daily.carbsG * share,
    fatG: daily.fatG * share,
  };

  const bounds = CALORIE_BOUNDS[SLOT_MECHANISM[mealType]];
  const clampedCalories = Math.min(Math.max(raw.calories, bounds.min), bounds.max);
  if (clampedCalories === raw.calories) return raw;

  const scale = clampedCalories / raw.calories;
  return {
    calories: clampedCalories,
    proteinG: raw.proteinG * scale,
    carbsG: raw.carbsG * scale,
    fatG: raw.fatG * scale,
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
