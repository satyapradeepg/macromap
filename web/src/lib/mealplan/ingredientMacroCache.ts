// Global cache wrapper around spoonacular.ts's lookupIngredientMacros --
// same "cache first, fetch/upsert on miss" shape as
// grocery/identityMatch.ts, grocery/unitConversion.ts,
// grocery/ingredientAisle.ts, and mealplan/recipeInstructions.ts. Closes a
// gap found in a 2026-07-27 quota-waste audit: every one of those already
// caches globally, but lookupIngredientMacros didn't -- so
// groundIngredientForAiMeal (orchestrate.ts), which has no static-table
// shortcut the way the fixed 9-ingredient snack/addon pool does, re-fetched
// live every time for every user, even for ingredient names Claude proposes
// repeatedly across many AI-composed meals ("chicken breast", "brown
// rice"). "N grams of ingredient X has Y calories/protein/carbs/fat" is a
// universal fact, not per-user or per-plan -- same reasoning as every other
// cache table here (migration 0025).

import { createAdminClient } from "@/lib/supabase/admin";
import { lookupIngredientMacros, type IngredientMacroLookup } from "@/lib/spoonacular";

function normalizeQuery(query: string): string {
  return query.toLowerCase().trim();
}

// aiSuggestedSearchTerm passes straight through to lookupIngredientMacros
// (see its own doc comment) -- the CACHE KEY stays the original query only,
// never the search term, so a later identical query hits the cache
// directly without needing the hint again, same as every other
// deterministic fallback already behaves.
export async function lookupIngredientMacrosCached(
  query: string,
  aiSuggestedSearchTerm?: string | null,
): Promise<IngredientMacroLookup | null> {
  const key = normalizeQuery(query);
  const admin = createAdminClient();
  const { data: cached } = await admin
    .from("ingredient_macro_lookup_cache")
    .select(
      "ingredient_id, name, calories_per_100g, protein_g_per_100g, carbs_g_per_100g, fat_g_per_100g, estimated_cost_cents_per_100g",
    )
    .eq("query_name", key)
    .maybeSingle();

  if (cached) {
    return {
      id: cached.ingredient_id,
      name: cached.name,
      caloriesPer100g: cached.calories_per_100g,
      proteinGPer100g: cached.protein_g_per_100g,
      carbsGPer100g: cached.carbs_g_per_100g,
      fatGPer100g: cached.fat_g_per_100g,
      estimatedCostCentsPer100g: cached.estimated_cost_cents_per_100g,
    };
  }

  // Errors (quota/outage) propagate to the caller unchanged -- same
  // contract as calling lookupIngredientMacros directly, this wrapper only
  // adds a cache layer in front, it doesn't change failure behavior.
  const fresh = await lookupIngredientMacros(query, aiSuggestedSearchTerm);
  if (!fresh) return null;

  await admin.from("ingredient_macro_lookup_cache").upsert(
    {
      query_name: key,
      ingredient_id: fresh.id,
      name: fresh.name,
      calories_per_100g: fresh.caloriesPer100g,
      protein_g_per_100g: fresh.proteinGPer100g,
      carbs_g_per_100g: fresh.carbsGPer100g,
      fat_g_per_100g: fresh.fatGPer100g,
      estimated_cost_cents_per_100g: fresh.estimatedCostCentsPer100g,
    },
    { onConflict: "query_name" },
  );

  return fresh;
}
