// Epic E2 (F3) — read-side shape for a persisted meal plan, shared by
// page.tsx (initial load) and actions.ts (outage fallback to the most
// recent plan). Not a Server Action file — plain data access.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MealType } from "@/lib/mealplan/targets";
import type { ToleranceTier } from "@/lib/mealplan/tolerance";
import type { MacroTargets } from "@/lib/mealplan/targets";

export interface PlanSlotAddonView {
  ingredientName: string;
  amountG: number;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface PlanSlotView {
  dayIndex: number;
  mealType: MealType;
  recipeId: number;
  recipeTitle: string;
  imageUrl: string | null;
  servings: number;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  pricePerServingCents: number | null;
  toleranceTier: ToleranceTier;
  matchLabel: string | null;
  addon: PlanSlotAddonView | null;
}

export interface BlockedSlotView {
  dayIndex: number;
  mealType: MealType;
  blockingHint: string;
}

export interface PlanView {
  id: string;
  generatedAt: string;
  reconciliationStatus: "within_band" | "outside_band_after_retries";
  weeklyTarget: MacroTargets;
  weeklyActual: MacroTargets;
  slots: PlanSlotView[];
  // Only populated on a freshly-generated plan (ephemeral, from the action's
  // return value) — blocked slots have no meal_plan_slots row, so a plan
  // reloaded from history can't recover which slots were blocked or why.
  blockedSlots: BlockedSlotView[];
}

export async function getMostRecentPlan(
  supabase: SupabaseClient,
  userId: string,
): Promise<PlanView | null> {
  const { data: plan } = await supabase
    .from("meal_plans")
    .select("*")
    .eq("user_id", userId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!plan) return null;

  const { data: slots } = await supabase
    .from("meal_plan_slots")
    .select("*")
    .eq("meal_plan_id", plan.id);

  const slotIds = (slots ?? []).map((s) => s.id);
  const { data: addonRows } =
    slotIds.length > 0
      ? await supabase.from("meal_plan_slot_addons").select("*").in("meal_plan_slot_id", slotIds)
      : { data: [] };
  const addonsBySlotId = new Map((addonRows ?? []).map((a) => [a.meal_plan_slot_id, a]));

  return {
    id: plan.id,
    generatedAt: plan.generated_at,
    reconciliationStatus: plan.reconciliation_status,
    weeklyTarget: {
      calories: plan.weekly_target_calories,
      proteinG: plan.weekly_target_protein_g,
      carbsG: plan.weekly_target_carbs_g,
      fatG: plan.weekly_target_fat_g,
    },
    weeklyActual: {
      calories: plan.weekly_actual_calories,
      proteinG: plan.weekly_actual_protein_g,
      carbsG: plan.weekly_actual_carbs_g,
      fatG: plan.weekly_actual_fat_g,
    },
    slots: (slots ?? []).map((s) => {
      const addonRow = addonsBySlotId.get(s.id);
      return {
        dayIndex: s.day_index,
        mealType: s.meal_type,
        recipeId: s.recipe_id,
        recipeTitle: s.recipe_title,
        imageUrl: s.image_url,
        servings: s.servings,
        calories: s.calories,
        proteinG: s.protein_g,
        carbsG: s.carbs_g,
        fatG: s.fat_g,
        pricePerServingCents: s.price_per_serving_cents,
        toleranceTier: s.tolerance_tier,
        matchLabel: s.match_label,
        addon: addonRow
          ? {
              ingredientName: addonRow.ingredient_name,
              amountG: addonRow.amount,
              caloriesKcal: addonRow.calories,
              proteinG: addonRow.protein_g,
              carbsG: addonRow.carbs_g,
              fatG: addonRow.fat_g,
            }
          : null,
      };
    }),
    blockedSlots: [],
  };
}
