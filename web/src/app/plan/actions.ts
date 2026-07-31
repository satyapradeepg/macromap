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
import type { CandidateIngredient, PantryItem } from "@/lib/mealplan/ranking";
import { buildTrackerFromKnownConsumption } from "@/lib/mealplan/pantryRemaining";
import { resolveRecipeInstructions } from "@/lib/mealplan/recipeInstructions";
import { generateAiComposedRecipeSteps } from "@/lib/mealplan/aiComposedRecipeInstructions";
import {
  buildGroceryLines,
  mergeConvertibleLines,
  pendingCrossCategoryConversions,
  conversionKey,
  type AddonEntry,
  type SlotIngredientEntry,
  type ResolvedLineConversion,
} from "@/lib/grocery/aggregate";
import { resolveConversionRateWithSource } from "@/lib/grocery/unitConversion";
import { checkGroceryList } from "@/lib/grocery/groceryCritic";
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
    .select("name, spoonacular_ingredient_id, amount, unit")
    .eq("user_id", userId);

  return (data ?? []).map((row) => ({
    name: row.name,
    spoonacularIngredientId: row.spoonacular_ingredient_id,
    amount: row.amount,
    unit: row.unit,
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

    // One-shot grocery-list sanity check (groceryCritic.ts, 2026-07-27) —
    // over the plan's OWN ingredient output (before pantry/pricing/aisle
    // resolution, which changes independently of the plan and doesn't need
    // a fresh check on every view — see that file's header comment for why
    // this only runs here, at generation time, never on the grocery list's
    // own hot read path). Best-effort: never throws, so a failure here
    // never blocks the real plan/grocery-list this pass runs alongside.
    const slotIngredientLists: SlotIngredientEntry[][] = result.slots.map((s) =>
      s.candidate.ingredients.map((i) => ({
        id: i.id,
        name: i.name,
        metricAmount: i.metricAmount,
        metricUnit: i.metricUnit,
      })),
    );
    const addonEntries: AddonEntry[] = result.slots.flatMap((s) =>
      s.addon
        ? [{ ingredientId: s.addon.spoonacularIngredientId, ingredientName: s.addon.ingredientName, amountG: s.addon.amountG }]
        : [],
    );
    const splitGroceryLines = buildGroceryLines(slotIngredientLists, addonEntries);
    // Found live 2026-07-27 (this feature's own first real trial): checking
    // buildGroceryLines' output directly, before reconciling the same-
    // ingredient splits it deliberately leaves apart on a unit mismatch,
    // produced a false positive -- e.g. flagging "1.36 small banana" /
    // "1.54 whole banana" as an unmerged duplicate, when two DIFFERENT
    // named "other"-category descriptors are a real, by-design non-merge
    // (see aggregate.ts's mergeConvertibleLines, same precedent as "medium"
    // vs "large" onion), and flagging a weight-vs-count split that would
    // have resolved fine via a real cross-category conversion rate. Running
    // the SAME reconciliation groceryData.ts's getGroceryList performs
    // (minus pantry/pricing/aisle, irrelevant to this check) before the
    // critique ever sees the list fixes this -- the critique now only ever
    // sees what a real shopper would, not an intermediate aggregation step.
    const pendingConversions = pendingCrossCategoryConversions(splitGroceryLines);
    const crossCategoryRates = new Map<string, ResolvedLineConversion>();
    await Promise.all(
      pendingConversions.map(async ({ ingredientId, name, sourceUnit, targetUnit }) => {
        const resolved = await resolveConversionRateWithSource(name, sourceUnit, targetUnit);
        if (resolved) crossCategoryRates.set(conversionKey(ingredientId, sourceUnit, targetUnit), resolved);
      }),
    );
    const rawGroceryLines = mergeConvertibleLines(splitGroceryLines, crossCategoryRates);
    const groceryNotes = await checkGroceryList(
      rawGroceryLines.map((l) => ({
        name: l.name,
        totalAmount: l.totalAmount,
        unit: l.unit,
        needsManualCombine: l.needsManualCombine,
      })),
    );

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
        weekly_assessment: result.weeklyAssessment,
        grocery_notes: groceryNotes,
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

    // .select() to get back each inserted row's id + slot identity — needed
    // to attach any F3 snack/add-on to the right meal_plan_slot_id below
    // (the addon table's FK requires the real DB row, not the in-memory
    // orchestration result).
    let insertedSlots: Array<{ id: string; day_index: number; meal_type: string }> = [];
    if (result.slots.length > 0) {
      const { data: slotsData, error: slotsError } = await supabase
        .from("meal_plan_slots")
        .insert(
          result.slots.map((s) => {
            // Composed snacks (snack1/snack2) and AI-composed meals
            // (aiMealComposition.ts) both use a synthetic negative id
            // (orchestrate.ts) since no single Spoonacular recipe backs
            // them — store as null with the right recipe_source rather
            // than persisting the synthetic id, which is only meaningful
            // within one generation call. aiComposed is checked first
            // since it's the more specific case.
            const isComposed = s.candidate.id < 0;
            const recipeSource = s.candidate.aiComposed ? "ai_composed" : isComposed ? "composed" : "spoonacular";
            return {
              meal_plan_id: insertedPlan.id,
              day_index: s.slotId.dayIndex,
              meal_type: s.slotId.mealType,
              recipe_id: isComposed ? null : s.candidate.id,
              recipe_source: recipeSource,
              recipe_title: s.candidate.title,
              image_url: s.candidate.imageUrl,
              servings: s.candidate.servings,
              calories: s.candidate.caloriesKcal,
              protein_g: s.candidate.proteinG,
              carbs_g: s.candidate.carbsG,
              fat_g: s.candidate.fatG,
              price_per_serving_cents: s.candidate.pricePerServingCents,
              scale_factor: s.candidate.scaleFactor,
              tolerance_tier: s.tier,
              match_label: s.matchLabel,
              ingredients: s.candidate.ingredients,
            };
          }),
        )
        .select("id, day_index, meal_type");
      if (slotsError) {
        return { plan: null, usingCachedFallback: false, error: slotsError.message };
      }
      insertedSlots = slotsData ?? [];

      const addonRows = result.slots.flatMap((s) => {
        if (!s.addon) return [];
        const row = insertedSlots.find(
          (r) => r.day_index === s.slotId.dayIndex && r.meal_type === s.slotId.mealType,
        );
        if (!row) return [];
        return [
          {
            meal_plan_slot_id: row.id,
            ingredient_name: s.addon.ingredientName,
            spoonacular_ingredient_id: s.addon.spoonacularIngredientId,
            amount: s.addon.amountG,
            unit: "g",
            calories: s.addon.caloriesKcal,
            protein_g: s.addon.proteinG,
            carbs_g: s.addon.carbsG,
            fat_g: s.addon.fatG,
          },
        ];
      });
      if (addonRows.length > 0) {
        const { error: addonsError } = await supabase.from("meal_plan_slot_addons").insert(addonRows);
        if (addonsError) {
          return { plan: null, usingCachedFallback: false, error: addonsError.message };
        }
      }
    }

    // Persona audit 2026-07-31, finding #3 (Phase 4): a slot that survives
    // every fallback (real-recipe cascade, all AI-compose attempts, pass
    // 4's relaxed-bounds last resort) had NO meal_plan_slots row at all --
    // only the ephemeral blockedSlots array below, which vanishes on the
    // next page load (see data.ts's getMostRecentPlan, which always
    // returns blockedSlots: []). Persists a real, honest placeholder row
    // instead so a reload can still show WHY this meal is missing, not
    // just silently omit it. recipe_source: 'unfilled' (migration
    // 0030_unfilled_slots.sql) keeps this distinct from every real
    // mechanism; blockingHint (always a real, non-empty string --
    // orchestrate.ts's blockedHints map) is stored directly as
    // recipe_title since there's no separate hint column and recipe_title
    // is NOT NULL. tolerance_tier is a neutral placeholder ('p30', the
    // column's NOT NULL check constraint requires a valid value) -- never
    // read as a real match quality for this recipe_source.
    if (result.blockedSlots.length > 0) {
      const { error: unfilledError } = await supabase.from("meal_plan_slots").insert(
        result.blockedSlots.map((b) => ({
          meal_plan_id: insertedPlan.id,
          day_index: b.slotId.dayIndex,
          meal_type: b.slotId.mealType,
          recipe_id: null,
          recipe_source: "unfilled",
          recipe_title: b.blockingHint,
          image_url: null,
          servings: 0,
          calories: 0,
          protein_g: 0,
          carbs_g: 0,
          fat_g: 0,
          price_per_serving_cents: null,
          scale_factor: 1,
          tolerance_tier: "p30",
          match_label: null,
          ingredients: [],
        })),
      );
      if (unfilledError) {
        return { plan: null, usingCachedFallback: false, error: unfilledError.message };
      }
    }

    const plan: PlanView = {
      id: insertedPlan.id,
      generatedAt: insertedPlan.generated_at,
      reconciliationStatus: result.reconciliationStatus,
      weeklyAssessment: result.weeklyAssessment,
      groceryNotes,
      weeklyTarget: result.weeklyTarget,
      weeklyActual: result.weeklyActual,
      slots: [
        ...result.slots.map((s) => {
          const isComposed = s.candidate.id < 0;
          return {
            dayIndex: s.slotId.dayIndex,
            mealType: s.slotId.mealType,
            recipeId: isComposed ? null : s.candidate.id,
            recipeTitle: s.candidate.title,
            isComposed,
            aiComposed: !!s.candidate.aiComposed,
            isUnfilled: false,
            composedIngredients: isComposed
              ? s.candidate.ingredients.map((i) => ({ name: i.name, amountG: i.amount }))
              : null,
            recipeIngredients: isComposed
              ? null
              : s.candidate.ingredients.map((i) => ({ name: i.name, amount: i.amount, unit: i.unit })),
            imageUrl: s.candidate.imageUrl,
            servings: s.candidate.servings,
            calories: s.candidate.caloriesKcal,
            proteinG: s.candidate.proteinG,
            carbsG: s.candidate.carbsG,
            fatG: s.candidate.fatG,
            pricePerServingCents: s.candidate.pricePerServingCents,
            scaleFactor: s.candidate.scaleFactor,
            toleranceTier: s.tier,
            matchLabel: s.matchLabel,
            addon: s.addon
              ? {
                  ingredientName: s.addon.ingredientName,
                  amountG: s.addon.amountG,
                  caloriesKcal: s.addon.caloriesKcal,
                  proteinG: s.addon.proteinG,
                  carbsG: s.addon.carbsG,
                  fatG: s.addon.fatG,
                }
              : null,
          };
        }),
        // Mirrors the placeholder rows just persisted above -- so the
        // immediate post-generation render already matches what a reload
        // will show via data.ts's getMostRecentPlan, instead of relying on
        // the separate ephemeral blockedSlots array below.
        ...result.blockedSlots.map((b) => ({
          dayIndex: b.slotId.dayIndex,
          mealType: b.slotId.mealType,
          recipeId: null,
          recipeTitle: b.blockingHint,
          isComposed: false,
          aiComposed: false,
          isUnfilled: true,
          composedIngredients: null,
          recipeIngredients: null,
          imageUrl: null,
          servings: 0,
          calories: 0,
          proteinG: 0,
          carbsG: 0,
          fatG: 0,
          pricePerServingCents: null,
          scaleFactor: 1,
          toleranceTier: "p30" as const,
          matchLabel: null,
          addon: null,
        })),
      ],
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
  weeklyActual: MacroTargets | null;
  blocked: boolean;
  blockingHint: string | null;
  error: string | null;
}

// A swap changes one slot's macros without regenerating the whole plan, so
// the plan-level weekly total (persisted at generation time, see
// generatePlan below) goes stale unless recomputed here from the current
// slots + add-ons — same sum orchestrate.ts's sumWithAddons does at
// generation time, just re-run against what's in the DB now.
export async function recomputeWeeklyActual(supabase: SupabaseClient, mealPlanId: string): Promise<MacroTargets> {
  const { data: slots } = await supabase
    .from("meal_plan_slots")
    .select("id, calories, protein_g, carbs_g, fat_g")
    .eq("meal_plan_id", mealPlanId);

  const slotIds = (slots ?? []).map((s) => s.id);
  const { data: addons } =
    slotIds.length > 0
      ? await supabase
          .from("meal_plan_slot_addons")
          .select("calories, protein_g, carbs_g, fat_g")
          .in("meal_plan_slot_id", slotIds)
      : { data: [] };

  const weeklyActual = [...(slots ?? []), ...(addons ?? [])].reduce(
    (total, row) => ({
      calories: total.calories + row.calories,
      proteinG: total.proteinG + row.protein_g,
      carbsG: total.carbsG + row.carbs_g,
      fatG: total.fatG + row.fat_g,
    }),
    { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  );

  await supabase
    .from("meal_plans")
    .update({
      weekly_actual_calories: weeklyActual.calories,
      weekly_actual_protein_g: weeklyActual.proteinG,
      weekly_actual_carbs_g: weeklyActual.carbsG,
      weekly_actual_fat_g: weeklyActual.fatG,
    })
    .eq("id", mealPlanId);

  return weeklyActual;
}

export async function swapMeal(input: SwapMealInput): Promise<SwapMealResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      slot: null,
      weeklyActual: null,
      blocked: false,
      blockingHint: null,
      error: "No active session — refresh the page and try again.",
    };
  }

  const profile = await loadProfile(supabase, user.id);
  if (!profile) {
    return {
      slot: null,
      weeklyActual: null,
      blocked: false,
      blockingHint: null,
      error: "Complete onboarding first.",
    };
  }

  const { data: existingSlots } = await supabase
    .from("meal_plan_slots")
    .select("recipe_id, day_index, meal_type, ingredients")
    .eq("meal_plan_id", input.mealPlanId);

  const excludeRecipeIds = (existingSlots ?? []).map((s) => s.recipe_id);

  // Every OTHER slot's ingredients (excluding the one being replaced, whose
  // own consumption shouldn't count against its replacement) — used to
  // build a pantry tracker that knows what the rest of the week's plan has
  // already used, so a swap doesn't score candidates against a pantry that
  // looks untouched. See buildTrackerFromKnownConsumption's own comment for
  // why this stays unresolved/no-network rather than matching critic-
  // repair's fully LLM-resolved in-generation swap tracker.
  const otherSlotsIngredients = (existingSlots ?? [])
    .filter((s) => !(s.day_index === input.dayIndex && s.meal_type === input.mealType))
    .map((s) => (s.ingredients as CandidateIngredient[] | null) ?? []);

  const dailyTargets: MacroTargets = {
    calories: profile.daily_calories,
    proteinG: profile.daily_protein_g,
    carbsG: profile.daily_carbs_g,
    fatG: profile.daily_fat_g,
  };
  const pantryItems = await loadPantryItems(supabase, user.id);
  const pantryTracker = buildTrackerFromKnownConsumption(pantryItems, otherSlotsIngredients);

  let swapResult;
  try {
    swapResult = await swapSlotCandidate({
      dailyTargets,
      mealType: input.mealType,
      dietaryStyles: profile.dietary_styles,
      allergies: profile.allergies,
      dislikes: profile.dislikes,
      tier: profile.tier,
      weeklyBudgetUsd: profile.weekly_budget_usd,
      excludeRecipeIds,
      pantryItems,
      pantryTracker,
    });
  } catch (err) {
    if (err instanceof SpoonacularQuotaError || err instanceof SpoonacularRequestError) {
      console.error("Meal swap failed:", err);
      return {
        slot: null,
        weeklyActual: null,
        blocked: false,
        blockingHint: null,
        error: "Unable to find a replacement right now — try again shortly.",
      };
    }
    throw err;
  }

  if (swapResult.blocked || !swapResult.candidate) {
    return {
      slot: null,
      weeklyActual: null,
      blocked: true,
      blockingHint: swapResult.blockingHint,
      error: null,
    };
  }

  // Composed snacks (snack1/snack2) use a synthetic negative id — see
  // generatePlan's insert above for why recipe_id/recipe_source differ.
  // swapSlotCandidate never produces an AI-composed candidate (that
  // fallback only runs during full generation, not a single swap), so
  // aiComposed is always false here — checked anyway for consistency
  // with generatePlan's logic rather than assuming it can't change later.
  const isComposed = swapResult.candidate.id < 0;
  const recipeSource = swapResult.candidate.aiComposed ? "ai_composed" : isComposed ? "composed" : "spoonacular";

  const { data: updatedSlot, error: updateError } = await supabase
    .from("meal_plan_slots")
    .update({
      recipe_id: isComposed ? null : swapResult.candidate.id,
      recipe_source: recipeSource,
      recipe_title: swapResult.candidate.title,
      image_url: swapResult.candidate.imageUrl,
      servings: swapResult.candidate.servings,
      calories: swapResult.candidate.caloriesKcal,
      protein_g: swapResult.candidate.proteinG,
      carbs_g: swapResult.candidate.carbsG,
      fat_g: swapResult.candidate.fatG,
      price_per_serving_cents: swapResult.candidate.pricePerServingCents,
      scale_factor: swapResult.candidate.scaleFactor,
      tolerance_tier: swapResult.tier,
      match_label: swapResult.matchLabel,
      ingredients: swapResult.candidate.ingredients,
    })
    .eq("meal_plan_id", input.mealPlanId)
    .eq("day_index", input.dayIndex)
    .eq("meal_type", input.mealType)
    .select("id")
    .single();

  if (updateError) {
    return { slot: null, weeklyActual: null, blocked: false, blockingHint: null, error: updateError.message };
  }

  // A swapped recipe invalidates any F3 snack/add-on that was sized/chosen
  // for the meal it's replacing — clear it rather than leaving a stale
  // add-on attached to an unrelated new recipe.
  if (updatedSlot) {
    await supabase.from("meal_plan_slot_addons").delete().eq("meal_plan_slot_id", updatedSlot.id);
  }

  const weeklyActual = await recomputeWeeklyActual(supabase, input.mealPlanId);

  const slot: PlanSlotView = {
    dayIndex: input.dayIndex,
    mealType: input.mealType,
    recipeId: isComposed ? null : swapResult.candidate.id,
    recipeTitle: swapResult.candidate.title,
    isComposed,
    aiComposed: !!swapResult.candidate.aiComposed,
    isUnfilled: false,
    composedIngredients: isComposed
      ? swapResult.candidate.ingredients.map((i) => ({ name: i.name, amountG: i.amount }))
      : null,
    recipeIngredients: isComposed
      ? null
      : swapResult.candidate.ingredients.map((i) => ({ name: i.name, amount: i.amount, unit: i.unit })),
    imageUrl: swapResult.candidate.imageUrl,
    servings: swapResult.candidate.servings,
    calories: swapResult.candidate.caloriesKcal,
    proteinG: swapResult.candidate.proteinG,
    carbsG: swapResult.candidate.carbsG,
    fatG: swapResult.candidate.fatG,
    pricePerServingCents: swapResult.candidate.pricePerServingCents,
    scaleFactor: swapResult.candidate.scaleFactor,
    toleranceTier: swapResult.tier!,
    matchLabel: swapResult.matchLabel,
    addon: null,
  };

  return { slot, weeklyActual, blocked: false, blockingHint: null, error: null };
}

export interface GetRecipeInstructionsResult {
  steps: string[];
  sourceUrl: string | null;
  error: string | null;
}

// Backs the "View recipe" detail (PlanView.tsx) — lazy-fetched only when a
// user actually opens a slot's recipe, not at generation time (see
// spoonacular.ts's fetchRecipeInstructions header comment for why this
// stays a separate per-recipe call rather than folded into complexSearch).
// recipeId is a public Spoonacular id, not a per-user resource, so this
// only gates on "an active session exists" (same defensive check as
// swapMeal/generatePlan) rather than checking slot ownership.
export async function getRecipeInstructions(recipeId: number): Promise<GetRecipeInstructionsResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { steps: [], sourceUrl: null, error: "No active session — refresh the page and try again." };
  }

  const result = await resolveRecipeInstructions(recipeId);
  if (!result) {
    return { steps: [], sourceUrl: null, error: "Recipe details unavailable right now — try again shortly." };
  }
  return { steps: result.steps, sourceUrl: result.sourceUrl, error: null };
}

export interface GetAiComposedRecipeInstructionsInput {
  mealPlanId: string;
  dayIndex: number;
  mealType: MealType;
}

export interface GetAiComposedRecipeInstructionsResult {
  steps: string[];
  error: string | null;
}

// Backs the "Recipe" detail for an AI-composed dish (2026-07-30, "AI meals
// should have a similar recipe experience to real Spoonacular meals" --
// Satya's explicit request), same lazy-on-open trigger as
// getRecipeInstructions above. UNLIKE that function, this reads/writes a
// specific user's specific slot (the ingredient list to write instructions
// FOR, and the cache column to persist them TO) -- not a public
// Spoonacular id -- so it uses the cookie-scoped, RLS-enforced client
// (same as swapMeal) rather than the admin client, and ownership is
// enforced by Postgres RLS on meal_plan_slots, not a manual check here.
export async function getAiComposedRecipeInstructions(
  input: GetAiComposedRecipeInstructionsInput,
): Promise<GetAiComposedRecipeInstructionsResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { steps: [], error: "No active session — refresh the page and try again." };
  }

  const { data: slot } = await supabase
    .from("meal_plan_slots")
    .select("id, recipe_title, recipe_source, ingredients, ai_recipe_instructions")
    .eq("meal_plan_id", input.mealPlanId)
    .eq("day_index", input.dayIndex)
    .eq("meal_type", input.mealType)
    .maybeSingle();

  if (!slot) {
    return { steps: [], error: "Meal not found — refresh the page and try again." };
  }
  // Defensive, not expected to trigger from the UI (the "Recipe" button is
  // only ever shown for an ai_composed slot) -- but this reads/writes a
  // slot by caller-supplied coordinates, so it shouldn't silently generate
  // instructions for a real Spoonacular recipe if ever called wrong.
  if (slot.recipe_source !== "ai_composed") {
    return { steps: [], error: "Instructions unavailable for this meal." };
  }

  if (slot.ai_recipe_instructions) {
    return { steps: slot.ai_recipe_instructions as string[], error: null };
  }

  const ingredients = (slot.ingredients as Array<{ name: string; amount: number }> | null ?? []).map((i) => ({
    name: i.name,
    amountG: i.amount,
  }));
  const steps = await generateAiComposedRecipeSteps(slot.recipe_title, ingredients);
  if (!steps) {
    return { steps: [], error: "Recipe details unavailable right now — try again shortly." };
  }

  // Best-effort persistence -- a failed write just means the next open
  // regenerates instead of hitting the cache; never blocks returning the
  // steps the user is waiting on right now.
  await supabase.from("meal_plan_slots").update({ ai_recipe_instructions: steps }).eq("id", slot.id);

  return { steps, error: null };
}
