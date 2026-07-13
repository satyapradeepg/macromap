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

// 3 meals/day — every meal slot targets an equal share of the daily total.
export function perMealTarget(daily: MacroTargets): MacroTargets {
  return {
    calories: daily.calories / MEAL_TYPES.length,
    proteinG: daily.proteinG / MEAL_TYPES.length,
    carbsG: daily.carbsG / MEAL_TYPES.length,
    fatG: daily.fatG / MEAL_TYPES.length,
  };
}

export function weeklyTarget(daily: MacroTargets): MacroTargets {
  return {
    calories: daily.calories * DAYS_PER_WEEK,
    proteinG: daily.proteinG * DAYS_PER_WEEK,
    carbsG: daily.carbsG * DAYS_PER_WEEK,
    fatG: daily.fatG * DAYS_PER_WEEK,
  };
}
