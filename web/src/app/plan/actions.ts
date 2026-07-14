"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  orchestrateGeneration,
  swapSlotCandidate,
  SpoonacularQuotaError,
  SpoonacularRequestError,
} from "@/lib/mealplan/orchestrate";
import type { MacroTargets, MealType } from "@/lib/mealplan/targets";
import type { PantryItem } from "@/lib/mealplan/ranking";
import { getMostRecentPlan, type PlanSlotView, type PlanView } from "./data";

interface ProfileRow {
  daily_calories: number;
  daily_protein_g: number;
  daily_carbs_g: number;
  daily_fat_g: number;
  dietary_styles: string[];
  allergies: string[];
  dislikes: string[];
  tier: "free" | "pro";
  weekly_budget_usd: number | null;
}

async function loadProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<ProfileRow | null> {
  const { data } = await supabase
    .from("profiles")
    .select(
      "daily_calories, daily_protein_g, daily_carbs_g, daily_fat_g, dietary_styles, allergies, dislikes, tier, weekly_budget_usd",
    )
    .eq("id", userId)
    .maybeSingle();
  return data;
}

// F6/F3 pantry-aware querying. Empty array is the correct/expected result
// until F6's entry UI exists — pantry entry is fully optional (PRD 7.3 F6),
// so no rows here just means generation behaves exactly as before.
async function loadPantryItems(
  supabase: SupabaseClient,
  userId: string,
): Promise<PantryItem[]> {
  const { data } = await supabase
    .from("pantry_items")
    .select("name, spoonacular_ingredient_id")
    .eq("user_id", userId);

  return (data ?? []).map((row) => ({
    name: row.name,
    spoonacularIngredientId: row.spoonacular_ingredient_id,
  }));
}

// This is the first data-returning Server Action in the codebase, unlike
// onboarding's `{ error }`-only convention (see actions.ts there) — error
// !== null means total failure; usingCachedFallback === true means success
// but with a stale (last week's) plan shown instead of a fresh generation.
export interface GeneratePlanResult {
  plan: PlanView | null;
  usingCachedFallback: boolean;
  error: string | null;
}

export async function generatePlan(): Promise<GeneratePlanResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      plan: null,
      usingCachedFallback: false,
      error: "No active session — refresh the page and try again.",
    };
  }

  const profile = await loadProfile(supabase, user.id);
  if (!profile) {
    return {
      plan: null,
      usingCachedFallback: false,
      error: "Complete onboarding before generating a meal plan.",
    };
  }

  const dailyTargets: MacroTargets = {
    calories: profile.daily_calories,
    proteinG: profile.daily_protein_g,
    carbsG: profile.daily_carbs_g,
    fatG: profile.daily_fat_g,
  };
  const pantryItems = await loadPantryItems(supabase, user.id);

  try {
    const result = await orchestrateGeneration({
      userId: user.id,
      dailyTargets,
      dietaryStyles: profile.dietary_styles,
      allergies: profile.allergies,
      dislikes: profile.dislikes,
      tier: profile.tier,
      weeklyBudgetUsd: profile.weekly_budget_usd,
      pantryItems,
    });

    const { data: insertedPlan, error: planError } = await supabase
      .from("meal_plans")
      .insert({
        user_id: user.id,
        weekly_target_calories: result.weeklyTarget.calories,
        weekly_target_protein_g: result.weeklyTarget.proteinG,
        weekly_target_carbs_g: result.weeklyTarget.carbsG,
        weekly_target_fat_g: result.weeklyTarget.fatG,
        weekly_actual_calories: result.weeklyActual.calories,
        weekly_actual_protein_g: result.weeklyActual.proteinG,
        weekly_actual_carbs_g: result.weeklyActual.carbsG,
        weekly_actual_fat_g: result.weeklyActual.fatG,
        reconciliation_status: result.reconciliationStatus,
        retry_queries_used: result.retryQueriesUsed,
      })
      .select()
      .single();

    if (planError || !insertedPlan) {
      return {
        plan: null,
        usingCachedFallback: false,
        error: planError?.message ?? "Failed to save the generated meal plan.",
      };
    }

    if (result.slots.length > 0) {
      const { error: slotsError } = await supabase.from("meal_plan_slots").insert(
        result.slots.map((s) => ({
          meal_plan_id: insertedPlan.id,
          day_index: s.slotId.dayIndex,
          meal_type: s.slotId.mealType,
          recipe_id: s.candidate.id,
          recipe_title: s.candidate.title,
          image_url: s.candidate.imageUrl,
          servings: s.candidate.servings,
          calories: s.candidate.caloriesKcal,
          protein_g: s.candidate.proteinG,
          carbs_g: s.candidate.carbsG,
          fat_g: s.candidate.fatG,
          price_per_serving_cents: s.candidate.pricePerServingCents,
          tolerance_tier: s.tier,
          match_label: s.matchLabel,
          ingredients: s.candidate.ingredients,
        })),
      );
      if (slotsError) {
        return { plan: null, usingCachedFallback: false, error: slotsError.message };
      }
    }

    const plan: PlanView = {
      id: insertedPlan.id,
      generatedAt: insertedPlan.generated_at,
      reconciliationStatus: result.reconciliationStatus,
      weeklyTarget: result.weeklyTarget,
      weeklyActual: result.weeklyActual,
      slots: result.slots.map((s) => ({
        dayIndex: s.slotId.dayIndex,
        mealType: s.slotId.mealType,
        recipeId: s.candidate.id,
        recipeTitle: s.candidate.title,
        imageUrl: s.candidate.imageUrl,
        servings: s.candidate.servings,
        calories: s.candidate.caloriesKcal,
        proteinG: s.candidate.proteinG,
        carbsG: s.candidate.carbsG,
        fatG: s.candidate.fatG,
        pricePerServingCents: s.candidate.pricePerServingCents,
        toleranceTier: s.tier,
        matchLabel: s.matchLabel,
      })),
      blockedSlots: result.blockedSlots.map((b) => ({
        dayIndex: b.slotId.dayIndex,
        mealType: b.slotId.mealType,
        blockingHint: b.blockingHint,
      })),
    };

    return { plan, usingCachedFallback: false, error: null };
  } catch (err) {
    if (err instanceof SpoonacularQuotaError || err instanceof SpoonacularRequestError) {
      // These fall back to a clean user-facing message below — log the
      // real cause here or it's otherwise unrecoverable for debugging.
      console.error("Meal plan generation failed, falling back:", err);
      const cached = await getMostRecentPlan(supabase, user.id);
      if (cached) {
        return { plan: cached, usingCachedFallback: true, error: null };
      }
      return {
        plan: null,
        usingCachedFallback: false,
        error: "Generation temporarily unavailable — try again shortly.",
      };
    }
    throw err;
  }
}

export interface SwapMealInput {
  mealPlanId: string;
  dayIndex: number;
  mealType: MealType;
}

export interface SwapMealResult {
  slot: PlanSlotView | null;
  blocked: boolean;
  blockingHint: string | null;
  error: string | null;
}

export async function swapMeal(input: SwapMealInput): Promise<SwapMealResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      slot: null,
      blocked: false,
      blockingHint: null,
      error: "No active session — refresh the page and try again.",
    };
  }

  const profile = await loadProfile(supabase, user.id);
  if (!profile) {
    return { slot: null, blocked: false, blockingHint: null, error: "Complete onboarding first." };
  }

  const { data: existingSlots } = await supabase
    .from("meal_plan_slots")
    .select("recipe_id")
    .eq("meal_plan_id", input.mealPlanId);

  const excludeRecipeIds = (existingSlots ?? []).map((s) => s.recipe_id);

  const dailyTargets: MacroTargets = {
    calories: profile.daily_calories,
    proteinG: profile.daily_protein_g,
    carbsG: profile.daily_carbs_g,
    fatG: profile.daily_fat_g,
  };
  const pantryItems = await loadPantryItems(supabase, user.id);

  let swapResult;
  try {
    swapResult = await swapSlotCandidate({
      dailyTargets,
      dietaryStyles: profile.dietary_styles,
      allergies: profile.allergies,
      dislikes: profile.dislikes,
      tier: profile.tier,
      weeklyBudgetUsd: profile.weekly_budget_usd,
      excludeRecipeIds,
      pantryItems,
    });
  } catch (err) {
    if (err instanceof SpoonacularQuotaError || err instanceof SpoonacularRequestError) {
      console.error("Meal swap failed:", err);
      return {
        slot: null,
        blocked: false,
        blockingHint: null,
        error: "Unable to find a replacement right now — try again shortly.",
      };
    }
    throw err;
  }

  if (swapResult.blocked || !swapResult.candidate) {
    return { slot: null, blocked: true, blockingHint: swapResult.blockingHint, error: null };
  }

  const { error: updateError } = await supabase
    .from("meal_plan_slots")
    .update({
      recipe_id: swapResult.candidate.id,
      recipe_title: swapResult.candidate.title,
      image_url: swapResult.candidate.imageUrl,
      servings: swapResult.candidate.servings,
      calories: swapResult.candidate.caloriesKcal,
      protein_g: swapResult.candidate.proteinG,
      carbs_g: swapResult.candidate.carbsG,
      fat_g: swapResult.candidate.fatG,
      price_per_serving_cents: swapResult.candidate.pricePerServingCents,
      tolerance_tier: swapResult.tier,
      match_label: swapResult.matchLabel,
      ingredients: swapResult.candidate.ingredients,
    })
    .eq("meal_plan_id", input.mealPlanId)
    .eq("day_index", input.dayIndex)
    .eq("meal_type", input.mealType);

  if (updateError) {
    return { slot: null, blocked: false, blockingHint: null, error: updateError.message };
  }

  const slot: PlanSlotView = {
    dayIndex: input.dayIndex,
    mealType: input.mealType,
    recipeId: swapResult.candidate.id,
    recipeTitle: swapResult.candidate.title,
    imageUrl: swapResult.candidate.imageUrl,
    servings: swapResult.candidate.servings,
    calories: swapResult.candidate.caloriesKcal,
    proteinG: swapResult.candidate.proteinG,
    carbsG: swapResult.candidate.carbsG,
    fatG: swapResult.candidate.fatG,
    pricePerServingCents: swapResult.candidate.pricePerServingCents,
    toleranceTier: swapResult.tier!,
    matchLabel: swapResult.matchLabel,
  };

  return { slot, blocked: false, blockingHint: null, error: null };
}
