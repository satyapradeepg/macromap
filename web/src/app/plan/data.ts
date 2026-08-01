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

export interface ComposedIngredientView {
  name: string;
  amountG: number;
}

// A real recipe's ingredient list, for the "View recipe" detail
// (PlanView.tsx) — amount/unit are the recipe's own native measurements
// (e.g. "2 cups"), not the metric ones grocery/aggregate.ts sums by, since
// a recipe reads more naturally in the units it was actually written in.
export interface RecipeIngredientView {
  name: string;
  amount: number;
  unit: string;
}

export interface PlanSlotView {
  dayIndex: number;
  mealType: MealType;
  // null for composed snacks (snack1/snack2) — no single Spoonacular recipe
  // backs them, see snackComposition.ts. isComposed distinguishes this from
  // a recipe-based slot rather than callers checking recipeId === null
  // directly, since a null id isn't self-explanatory on its own.
  recipeId: number | null;
  recipeTitle: string;
  isComposed: boolean;
  // True only for the AI composition fallback (aiMealComposition.ts) —
  // distinguishes a real, named, AI-composed DISH (still isComposed, since
  // it also has no single Spoonacular recipe backing it) from a plain
  // composed SNACK, so the UI can show a video-search link and different
  // copy for the former (see PlanView.tsx's MealCard).
  aiComposed: boolean;
  // Persona audit 2026-07-31, finding #3 (Phase 4): true only for a
  // placeholder row (recipe_source: 'unfilled') persisted when every
  // fallback failed to fill this slot -- recipeTitle carries the honest
  // reason (orchestrate.ts's blockingHint) rather than a real dish name.
  // Every other field on this slot is a zeroed/null placeholder value, not
  // real data -- callers must check this FIRST and render the hint state,
  // never the normal meal-card fields, when it's true.
  isUnfilled: boolean;
  composedIngredients: ComposedIngredientView[] | null;
  // null for composed/AI-composed slots (no single recipe backs them — see
  // composedIngredients above instead). Populated from the same persisted
  // ingredients this slot's grocery-list lines are already derived from
  // (aggregate.ts), just in the recipe's native amount/unit rather than
  // grocery/units.ts's metric grams/ml.
  recipeIngredients: RecipeIngredientView[] | null;
  imageUrl: string | null;
  servings: number;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  pricePerServingCents: number | null;
  // Multiplier applied to a recipe's native serving to fit its slot's macro
  // target (ranking.ts's bestScaleAndScore, July 20 2026 spec). 1 for
  // composed snacks/AI-composed meals (already sized directly to target).
  // Not surfaced in the UI today (decided against a visible "1.4x serving"
  // note) — kept for display/debugging since every macro field above
  // already reflects the scaled amount, not the recipe's native one.
  scaleFactor: number;
  toleranceTier: ToleranceTier;
  matchLabel: string | null;
  addon: PlanSlotAddonView | null;
}

export interface BlockedSlotView {
  dayIndex: number;
  mealType: MealType;
  blockingHint: string;
}

export interface UnresolvedDietaryConcernView {
  dayIndex: number;
  mealType: MealType;
  note: string;
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
  // Same ephemeral-only shape as blockedSlots above, for the same reason --
  // orchestrate.ts's post-generation repair pass computes this in memory
  // (a diet_violation flag it couldn't resolve even after a real swap
  // attempt and the AI-composition fallback) but nothing persists it, so a
  // reloaded plan can't recover which slot it was or why. Expected empty
  // in the overwhelming majority of plans -- see PlanView.tsx's banner.
  unresolvedDietaryConcerns: UnresolvedDietaryConcernView[];
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
      const aiComposed = s.recipe_source === "ai_composed";
      const isComposed = s.recipe_source === "composed" || aiComposed;
      const isUnfilled = s.recipe_source === "unfilled";
      return {
        dayIndex: s.day_index,
        mealType: s.meal_type,
        recipeId: s.recipe_id,
        recipeTitle: s.recipe_title,
        isComposed,
        aiComposed,
        isUnfilled,
        composedIngredients: isComposed
          ? (s.ingredients as Array<{ name: string; amount: number }>).map((i) => ({
              name: i.name,
              amountG: i.amount,
            }))
          : null,
        recipeIngredients: isComposed
          ? null
          : (s.ingredients as Array<{ name: string; amount: number; unit: string }>).map((i) => ({
              name: i.name,
              amount: i.amount,
              unit: i.unit,
            })),
        imageUrl: s.image_url,
        servings: s.servings,
        calories: s.calories,
        proteinG: s.protein_g,
        carbsG: s.carbs_g,
        fatG: s.fat_g,
        pricePerServingCents: s.price_per_serving_cents,
        scaleFactor: s.scale_factor,
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
    unresolvedDietaryConcerns: [],
  };
}
