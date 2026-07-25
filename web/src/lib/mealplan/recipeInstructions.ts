// Global cache wrapper around spoonacular.ts's fetchRecipeInstructions,
// backing the meal-plan card's "View recipe" detail (PlanView.tsx). Same
// "cache first, fetch/upsert on miss" shape as grocery/identityMatch.ts and
// grocery/unitConversion.ts, and the same reasoning: a recipe's cooking
// steps are a universal fact keyed only by its Spoonacular id, not per-user
// or per-plan, so any recipe reused across users' plans only ever costs one
// real Spoonacular call (migration 0022_recipe_instructions_cache.sql).

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchRecipeInstructions, SpoonacularQuotaError, SpoonacularRequestError, type RecipeInstructions } from "@/lib/spoonacular";

export async function resolveRecipeInstructions(recipeId: number): Promise<RecipeInstructions | null> {
  const admin = createAdminClient();
  const { data: cached } = await admin
    .from("recipe_instructions_cache")
    .select("steps, source_url")
    .eq("recipe_id", recipeId)
    .maybeSingle();

  if (cached) {
    return { steps: cached.steps as string[], sourceUrl: cached.source_url };
  }

  let fetched: RecipeInstructions | null;
  try {
    fetched = await fetchRecipeInstructions(recipeId);
  } catch (err) {
    // Quota/outage -- surfaced to the caller as "unavailable right now"
    // rather than a permanent negative cache entry, same "a transient API
    // error doesn't calcify into a permanent wrong answer" precedent as
    // identityMatch.ts's resolveIdentityMatches.
    if (err instanceof SpoonacularQuotaError || err instanceof SpoonacularRequestError) return null;
    throw err;
  }
  if (!fetched) return null;

  await admin
    .from("recipe_instructions_cache")
    .upsert(
      { recipe_id: recipeId, steps: fetched.steps, source_url: fetched.sourceUrl },
      { onConflict: "recipe_id" },
    );

  return fetched;
}
