// Epic E2 (F3) — Spoonacular /recipes/complexSearch client. Native fetch,
// no HTTP library (matches E1's zero-new-deps convention). addRecipeInformation
// and fillIngredients are always requested so nutrition + ingredient measures
// come back in this single call (OQ4/OQ6 — no second per-recipe call, ever).
//
// USES Spoonacular's own minProtein/maxProtein/minCalories/maxCalories filter
// (OQ2's original design) — an earlier attempt to drop this in favor of a
// broad unfiltered fetch + local matching was reverted after live testing:
// for a general/unrestricted profile, Spoonacular's corpus is large enough
// (5000+ recipes) that fetching the first N with NO filter is close to a
// random sample, and only ~4% of a random sample falls in a typical macro
// band — that starved variety far worse than the filter itself ever did.
// The filter genuinely does return very few matches for some diet+macro
// combinations (e.g. vegetarian + high protein + common exclusions can drop
// to single digits even at the widest tolerance) but that reflects real
// data scarcity in Spoonacular's corpus, not an overly-restrictive filter —
// verified by comparing filtered vs. unfiltered result counts directly
// against the live API for both a scarce and a plentiful profile.
//
// addRecipeNutrition=true is kept in addition to the nutrient filter as a
// safety net — confirmed nutrition.nutrients also comes back correctly
// without it whenever a nutrient filter is present, but every call path
// here always includes bounds, so this costs nothing extra in practice and
// protects against ever silently getting zeroed-out macros again.
//
// Pantry preference (F6/F3) is deliberately NOT sent here as Spoonacular's
// includeIngredients param, despite PRD 7.3 F3 describing it as "passed to
// the Spoonacular query" — pantry contents are per-user, and folding them
// into the real request would fragment the cross-user recipe_query_cache
// (cacheKey.ts) to near-zero hit rate, the same reason excludeIds is kept
// out of the cache key. Same tradeoff already made for carb/fat bounds
// (see the module comment above): handled as a local post-fetch ranking
// preference instead (ranking.ts's pantryOverlapDeduction), over the same
// shared candidate pool every user's query already produces. PRD wording
// should be corrected to match next time the docs are touched.

import type { MacroBounds } from "./mealplan/tolerance";
import type { RecipeCandidate } from "./mealplan/ranking";

const BASE_URL = "https://api.spoonacular.com/recipes/complexSearch";

export class SpoonacularQuotaError extends Error {}
export class SpoonacularRequestError extends Error {}

export interface ComplexSearchArgs {
  bounds: MacroBounds;
  diet?: string;
  intolerances?: string[];
  excludeIngredients: string[];
  excludeIds: number[];
  number: number;
  // Meal-type realism (live-confirmed July 2026: type=breakfast returns
  // genuinely breakfast-appropriate dishes, type=main course returns
  // lunch/dinner-appropriate ones — not just a label, a real filter).
  // Optional so callers that don't care about meal-type (e.g. none yet,
  // but keeps the client itself meal-type-agnostic) can omit it.
  type?: string;
}

// Spoonacular's documented complexSearch params don't include a direct
// "exclude these recipe ids" filter — filtered client-side below regardless
// of what a live-docs check confirms, so this stays correct either way.
export async function complexSearch(args: ComplexSearchArgs): Promise<RecipeCandidate[]> {
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) {
    throw new SpoonacularRequestError("SPOONACULAR_API_KEY is not set");
  }

  // args.bounds also carries minCarbs/maxCarbs/minFat/maxFat (MacroBounds
  // now includes them for ranking.ts's local macroCompliant preference) —
  // deliberately not read here; verified live that adding them as a HARD
  // filter here starves the shared 21-slot pool (see header comment).
  const params = new URLSearchParams({
    apiKey,
    minProtein: String(args.bounds.minProtein),
    maxProtein: String(args.bounds.maxProtein),
    minCalories: String(args.bounds.minCalories),
    maxCalories: String(args.bounds.maxCalories),
    addRecipeInformation: "true",
    addRecipeNutrition: "true",
    fillIngredients: "true",
    number: String(args.number),
  });
  if (args.diet) params.set("diet", args.diet);
  if (args.intolerances && args.intolerances.length > 0) {
    params.set("intolerances", args.intolerances.join(","));
  }
  if (args.excludeIngredients.length > 0) {
    params.set("excludeIngredients", args.excludeIngredients.join(","));
  }
  if (args.type) params.set("type", args.type);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}?${params.toString()}`);
  } catch (err) {
    throw new SpoonacularRequestError(`Spoonacular request failed: ${(err as Error).message}`);
  }

  if (response.status === 402 || response.status === 429) {
    throw new SpoonacularQuotaError(`Spoonacular quota exceeded (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new SpoonacularRequestError(`Spoonacular request failed (HTTP ${response.status})`);
  }

  let body: SpoonacularComplexSearchResponse;
  try {
    body = await response.json();
  } catch (err) {
    throw new SpoonacularRequestError(`Spoonacular response was not valid JSON: ${(err as Error).message}`);
  }

  const excludeIds = new Set(args.excludeIds);
  return body.results.filter((r) => !excludeIds.has(r.id)).map(mapToCandidate);
}

// Only the fields F3 needs from Spoonacular's response — not a full schema.
interface SpoonacularComplexSearchResponse {
  results: SpoonacularRecipe[];
}

interface SpoonacularRecipe {
  id: number;
  title: string;
  image?: string;
  servings: number;
  pricePerServing?: number; // cents
  aggregateLikes?: number;
  nutrition?: {
    nutrients: Array<{ name: string; amount: number }>;
  };
  extendedIngredients?: Array<{
    id: number;
    name: string;
    amount: number;
    unit: string;
    measures?: {
      metric?: { amount: number; unitShort: string };
    };
  }>;
}

function nutrientAmount(recipe: SpoonacularRecipe, name: string): number {
  const nutrient = recipe.nutrition?.nutrients.find(
    (n) => n.name.toLowerCase() === name.toLowerCase(),
  );
  return nutrient?.amount ?? 0;
}

// F3 snack/add-on gap-closer — Spoonacular's ingredient-level endpoints,
// live-confirmed (July 2026) to exist and cost a flat 1.0pt/call each, and
// to return full macro data via the same nutrition.nutrients shape as
// complexSearch above (reuses nutrientAmount below). Grounding rule (PRD
// 7.3 F3): the add-on's macros always come from here, never LLM-estimated.
export interface IngredientMacroLookup {
  id: number;
  name: string;
  caloriesPer100g: number;
  proteinGPer100g: number;
  carbsGPer100g: number;
  fatGPer100g: number;
  // Real, live-confirmed field (July 15 2026): Spoonacular returns this by
  // default on the same information call already made for macros, no
  // extra request needed. null only if Spoonacular itself has no cost
  // data for this specific ingredient — never fabricated/estimated here.
  estimatedCostCentsPer100g: number | null;
}

interface SpoonacularIngredientSearchResponse {
  results: Array<{ id: number; name: string }>;
}

interface SpoonacularIngredientInformationResponse {
  id: number;
  name: string;
  estimatedCost?: { value: number; unit: string };
  nutrition?: {
    nutrients: Array<{ name: string; amount: number }>;
  };
}

function nutrientAmountFrom(nutrients: Array<{ name: string; amount: number }>, name: string): number {
  const nutrient = nutrients.find((n) => n.name.toLowerCase() === name.toLowerCase());
  return nutrient?.amount ?? 0;
}

// Combines search + information into the one lookup the add-on mechanism
// actually needs — returns null (not a thrown error) on quota/request
// failure or a zero-result search, since a missing add-on ingredient is an
// expected, handled case (reconciliation falls through to the slack-meal
// requery), not an outage.
export async function lookupIngredientMacros(query: string): Promise<IngredientMacroLookup | null> {
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) {
    throw new SpoonacularRequestError("SPOONACULAR_API_KEY is not set");
  }

  const searchParams = new URLSearchParams({ apiKey, query, number: "1" });
  const searchRes = await fetch(`https://api.spoonacular.com/food/ingredients/search?${searchParams.toString()}`);
  if (searchRes.status === 402 || searchRes.status === 429) {
    throw new SpoonacularQuotaError(`Spoonacular quota exceeded (HTTP ${searchRes.status})`);
  }
  if (!searchRes.ok) return null;

  const searchBody = (await searchRes.json()) as SpoonacularIngredientSearchResponse;
  const match = searchBody.results[0];
  if (!match) return null;

  const infoParams = new URLSearchParams({ apiKey, amount: "100", unit: "grams" });
  const infoRes = await fetch(
    `https://api.spoonacular.com/food/ingredients/${match.id}/information?${infoParams.toString()}`,
  );
  if (infoRes.status === 402 || infoRes.status === 429) {
    throw new SpoonacularQuotaError(`Spoonacular quota exceeded (HTTP ${infoRes.status})`);
  }
  if (!infoRes.ok) return null;

  const info = (await infoRes.json()) as SpoonacularIngredientInformationResponse;
  const nutrients = info.nutrition?.nutrients ?? [];
  return {
    id: info.id,
    name: info.name,
    caloriesPer100g: nutrientAmountFrom(nutrients, "Calories"),
    proteinGPer100g: nutrientAmountFrom(nutrients, "Protein"),
    carbsGPer100g: nutrientAmountFrom(nutrients, "Carbohydrates"),
    fatGPer100g: nutrientAmountFrom(nutrients, "Fat"),
    // A present-but-zero value is indistinguishable from "genuinely no
    // cost data" in Spoonacular's response, so both map to null here
    // rather than a fabricated $0.00 that would look like a real answer.
    estimatedCostCentsPer100g: info.estimatedCost?.value ? info.estimatedCost.value : null,
  };
}

function mapToCandidate(recipe: SpoonacularRecipe): RecipeCandidate {
  return {
    id: recipe.id,
    title: recipe.title,
    imageUrl: recipe.image ?? null,
    servings: recipe.servings,
    proteinG: nutrientAmount(recipe, "Protein"),
    caloriesKcal: nutrientAmount(recipe, "Calories"),
    carbsG: nutrientAmount(recipe, "Carbohydrates"),
    fatG: nutrientAmount(recipe, "Fat"),
    // Spoonacular returns pricePerServing as cents with a fractional part
    // (e.g. 791.17) — round here so every downstream consumer (ranking's
    // budget comparison, the DB's integer column) sees whole cents.
    pricePerServingCents:
      recipe.pricePerServing !== undefined ? Math.round(recipe.pricePerServing) : null,
    aggregateLikes: recipe.aggregateLikes ?? 0,
    ingredients: (recipe.extendedIngredients ?? []).map((ing) => ({
      id: ing.id,
      name: ing.name,
      amount: ing.amount,
      unit: ing.unit,
      metricAmount: ing.measures?.metric?.amount ?? ing.amount,
      metricUnit: ing.measures?.metric?.unitShort ?? ing.unit,
    })),
  };
}
