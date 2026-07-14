// F1 TDEE Calculator & Macro Onboarding — docs/PRD-MacroMap.md Section 7.3.
// Pure calculation functions, no side effects, so they're easy to unit test
// and reuse both client-side (live preview) and server-side (on submit).

export type BiologicalSex = "male" | "female";
export type ActivityLevel =
  | "sedentary"
  | "lightly_active"
  | "active"
  | "very_active";
export type Goal = "cut" | "bulk" | "maintain";

export const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  lightly_active: 1.375,
  active: 1.55,
  very_active: 1.725,
};

// PRD 7.3 F1 input validation ranges — mirrored as check constraints on
// supabase/migrations/0001_profiles.sql's profiles table.
export const AGE_RANGE = { min: 13, max: 100 };
export const WEIGHT_KG_RANGE = { min: 30, max: 300 };
export const HEIGHT_CM_RANGE = { min: 100, max: 250 };

interface BmrInput {
  weightKg: number;
  heightCm: number;
  age: number;
  biologicalSex: BiologicalSex;
}

// Mifflin-St Jeor. The +5/-161 sex-specific constant is why biological sex
// is a required onboarding input (see PRD F1 for the discovery note).
export function calculateBmr({
  weightKg,
  heightCm,
  age,
  biologicalSex,
}: BmrInput): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return biologicalSex === "male" ? base + 5 : base - 161;
}

export function calculateTdee(bmr: number, activityLevel: ActivityLevel): number {
  return bmr * ACTIVITY_MULTIPLIERS[activityLevel];
}

export interface MacroTargets {
  dailyCalories: number;
  dailyProteinG: number;
  dailyCarbsG: number;
  dailyFatG: number;
}

// PRD 7.3 F1 "Default macro splits by goal" table.
const MACRO_SPLIT_RULES: Record<
  Goal,
  { proteinGPerKg: number; fatPercentOfCalories: number }
> = {
  cut: { proteinGPerKg: 2.2, fatPercentOfCalories: 0.25 },
  bulk: { proteinGPerKg: 1.8, fatPercentOfCalories: 0.25 },
  maintain: { proteinGPerKg: 1.6, fatPercentOfCalories: 0.3 },
};

// Goal-based caloric adjustment (PRD F1 backlog item, added July 2026):
// calories used to equal TDEE for every goal, so "cut" only reallocated
// macros at maintenance calories instead of creating an actual deficit.
// Multipliers land within standard evidence-based ranges (cut ~15-25%
// deficit, lean bulk ~10-15% surplus). Protein is deliberately computed
// from bodyweight (g/kg), not from the adjusted calories, so a cut doesn't
// shrink the protein target along with total calories — preserving lean
// mass during a deficit is the point of the higher cut g/kg figure above.
const GOAL_CALORIE_MULTIPLIER: Record<Goal, number> = {
  cut: 0.8,
  bulk: 1.1,
  maintain: 1.0,
};

export function calculateMacroTargets(
  tdee: number,
  weightKg: number,
  goal: Goal,
): MacroTargets {
  const { proteinGPerKg, fatPercentOfCalories } = MACRO_SPLIT_RULES[goal];
  const dailyCalories = tdee * GOAL_CALORIE_MULTIPLIER[goal];

  const proteinG = proteinGPerKg * weightKg;
  const proteinCalories = proteinG * 4;

  const fatCalories = dailyCalories * fatPercentOfCalories;
  const fatG = fatCalories / 9;

  const carbsCalories = Math.max(0, dailyCalories - proteinCalories - fatCalories);
  const carbsG = carbsCalories / 4;

  return {
    dailyCalories: Math.round(dailyCalories),
    dailyProteinG: Math.round(proteinG),
    dailyCarbsG: Math.round(carbsG),
    dailyFatG: Math.round(fatG),
  };
}
