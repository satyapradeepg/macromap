"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/identity";
import type { ActivityLevel, BiologicalSex, Goal } from "@/lib/tdee";

export interface SaveProfileInput {
  weightKg: number;
  heightCm: number;
  age: number;
  biologicalSex: BiologicalSex;
  activityLevel: ActivityLevel;
  goal: Goal;
  dailyCalories: number;
  dailyProteinG: number;
  dailyCarbsG: number;
  dailyFatG: number;
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
  weeklyBudgetUsd: number | null;
  zipCode: string | null;
}

export async function saveProfile(
  input: SaveProfileInput,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const user = await getCurrentUser();

  if (!user) {
    return { error: "No active session — refresh the page and try again." };
  }

  const { error } = await supabase.from("profiles").upsert({
    id: user.id,
    weight_kg: input.weightKg,
    height_cm: input.heightCm,
    age: input.age,
    biological_sex: input.biologicalSex,
    activity_level: input.activityLevel,
    goal: input.goal,
    daily_calories: input.dailyCalories,
    daily_protein_g: input.dailyProteinG,
    daily_carbs_g: input.dailyCarbsG,
    daily_fat_g: input.dailyFatG,
    dietary_styles: input.dietaryStyles,
    allergies: input.allergies,
    dislikes: input.dislikes,
    weekly_budget_usd: input.weeklyBudgetUsd,
    zip_code: input.zipCode,
    updated_at: new Date().toISOString(),
  });

  return { error: error?.message ?? null };
}
