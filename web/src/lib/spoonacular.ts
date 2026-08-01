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
  aisle?: string;
  nutrition?: {
    nutrients: Array<{ name: string; amount: number }>;
  };
}

function nutrientAmountFrom(nutrients: Array<{ name: string; amount: number }>, name: string): number {
  const nutrient = nutrients.find((n) => n.name.toLowerCase() === name.toLowerCase());
  return nutrient?.amount ?? 0;
}

// Spoonacular's ingredient search wants a bare/canonical name and doesn't
// reliably match a USDA-style comma-separated phrasing Claude sometimes
// produces (e.g. "jasmine rice, cooked") -- live-confirmed 2026-07-21:
// this exact query returned zero results even though "cooked jasmine
// rice" is a completely ordinary, searchable ingredient. Only handles a
// single comma, and only REORDERS the two clauses rather than dropping
// either one -- deliberately conservative, since dropping a modifier
// like "cooked" could silently match the wrong real ingredient (raw vs.
// cooked rice have very different macros per 100g; reordering the exact
// same words carries no such risk).
export function commaSwapFallback(query: string): string | null {
  const parts = query.split(",");
  if (parts.length !== 2) return null;
  const [before, after] = parts.map((p) => p.trim());
  if (!before || !after) return null;
  return `${after} ${before}`;
}

// Audit item #1 (2026-07-21 spec): the comma-swap fallback above only
// covers a "name, modifier" phrasing -- it does nothing for the same
// prep-word appearing as a plain leading prefix with no comma at all,
// e.g. "steamed broccoli florets" or "steamed baby carrots" (both
// live-confirmed zero-result Spoonacular searches this same session, in
// Finding 2, before that was worked around by dropping the item entirely
// rather than fixing the lookup). Only strips a LEADING prep-word, never
// touches the rest of the name -- same conservative reasoning as
// commaSwapFallback: this is a reorder/strip of a prep descriptor, not a
// guess at a different ingredient.
//
// "sliced" added 2026-07-27 (marathon-session queue item #2): a live
// AI-compose diagnostic against vegetarian_cut found the same zero-result
// pattern for a leading "sliced" (e.g. "sliced avocado"). Same shape
// descriptor risk profile as the rest of this list -- slicing doesn't
// change a food's per-100g macros, so dropping it is safe the same way
// dropping "steamed"/"roasted" is.
const PREP_PREFIXES = [
  "steamed", "roasted", "grilled", "sauteed", "sautéed", "cooked", "baked", "boiled", "fried", "sliced",
];

// Trailing counterpart to PREP_PREFIXES, added 2026-07-27 for the same
// vegetarian_cut diagnostic: Claude's AI-compose sometimes names a
// meat-analogue ingredient with a trailing shape/form descriptor Spoonacular's
// search doesn't recognize either, e.g. "tempeh bacon strips" or "seitan
// crumbles". Like "sliced", "strips"/"crumbles" describe a cut/shape, not a
// distinct reformulated product, so dropping them carries the same low risk
// as the leading-prefix case -- confirmed by checking each term names a
// shape, not a branded product, before adding it here (see the module
// comment on glutenFreeQualifierStripFallback below for the class of risk
// this deliberately avoids: a qualifier that names a genuinely different
// product must NOT be added to this list).
const TRAILING_DESCRIPTORS = ["strips", "crumbles"];

export function prefixStripFallback(query: string): string | null {
  const trimmed = query.trim();
  for (const prefix of PREP_PREFIXES) {
    const match = new RegExp(`^${prefix}\\s+`, "i").exec(trimmed);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      return rest || null;
    }
  }
  for (const suffix of TRAILING_DESCRIPTORS) {
    const match = new RegExp(`\\s+${suffix}$`, "i").exec(trimmed);
    if (match) {
      const rest = trimmed.slice(0, match.index).trim();
      return rest || null;
    }
  }
  return null;
}

// Sibling gap to audit item #1 above, live-confirmed 2026-07-22
// (stacked-safety re-verification): "gluten-free rolled oats" and "rolled
// oats (gluten-free)" both returned zero results from Spoonacular's
// search, even after the openEndedIngredientSafety.ts fix that stopped
// wrongly flagging this exact phrasing as unsafe -- the search itself
// doesn't recognize a "gluten-free" qualifier as a food-name modifier,
// in either the leading ("gluten-free X") or trailing parenthetical
// ("X (gluten-free)") form Claude actually produced live.
//
// Deliberately scoped to "gluten-free" ONLY, not generalized to other
// allergen-free qualifiers (dairy-free, nut-free, etc.) the way
// PREP_PREFIXES generalizes across several prep words at once -- most
// "X-free" labels name a genuinely DIFFERENT reformulated product
// (dairy-free "cheese" is a plant-based substitute with different real
// macros), where dropping the qualifier would risk silently matching the
// wrong food, the same class of risk commaSwapFallback's own docs warn
// about. "Gluten-free" is the one case that's safe to generalize: gluten-
// free oats/rice/etc. are nutritionally the same food as their regular
// counterpart -- the label is a cross-contamination/certification claim,
// not a reformulation. If another qualifier is confirmed live to need
// the same treatment, reconsider this scoping then rather than
// speculatively widening it now.
export function glutenFreeQualifierStripFallback(query: string): string | null {
  const trimmed = query.trim();
  const leading = /^gluten[-\s]free\s+(.+)$/i.exec(trimmed);
  if (leading) return leading[1].trim() || null;
  const trailing = /^(.+?)\s*\(\s*gluten[-\s]free\s*\)$/i.exec(trimmed);
  if (trailing) return trailing[1].trim() || null;
  return null;
}

interface IngredientSearchMatch {
  id: number;
}

// Factored out so lookupIngredientMacros can try a reformatted query as a
// fallback without duplicating the request/error-handling logic. Throws
// SpoonacularQuotaError on 402/429 (a retry would fail identically, no
// point spending a second call), returns null for "no match" or any other
// non-ok response.
async function searchIngredient(query: string, apiKey: string): Promise<IngredientSearchMatch | null> {
  const searchParams = new URLSearchParams({ apiKey, query, number: "1" });
  const searchRes = await fetch(`https://api.spoonacular.com/food/ingredients/search?${searchParams.toString()}`);
  if (searchRes.status === 402 || searchRes.status === 429) {
    throw new SpoonacularQuotaError(`Spoonacular quota exceeded (HTTP ${searchRes.status})`);
  }
  if (!searchRes.ok) return null;

  const searchBody = (await searchRes.json()) as SpoonacularIngredientSearchResponse;
  return searchBody.results[0] ?? null;
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

  let match = await searchIngredient(query, apiKey);
  if (!match) {
    const commaSwapped = commaSwapFallback(query);
    if (commaSwapped) match = await searchIngredient(commaSwapped, apiKey);
  }
  if (!match) {
    const prefixStripped = prefixStripFallback(query);
    if (prefixStripped) match = await searchIngredient(prefixStripped, apiKey);
  }
  if (!match) {
    const glutenFreeStripped = glutenFreeQualifierStripFallback(query);
    if (glutenFreeStripped) match = await searchIngredient(glutenFreeStripped, apiKey);
  }
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

export interface IngredientCostLookup {
  costCents: number | null;
  // Same response this cost lookup already fetched also carries the
  // ingredient's real aisle (see lookupIngredientAisle's header comment
  // below) -- exposed here so a Pro-tier price lookup can seed
  // ingredient_aisle_cache from data it already paid for, instead of
  // groceryData.ts firing a second, separate call to this exact same
  // Spoonacular endpoint just to get the aisle. null when Spoonacular
  // didn't return one (or returned several ";"-joined ones with none
  // parseable — see parsePrimaryAisle).
  aisle: string | null;
}

// Epic E3 (F4) grocery pricing — reuses the same ingredient information
// endpoint as lookupIngredientMacros above, but a grocery line already
// carries its resolved spoonacular_ingredient_id (from the recipe/
// composition data that produced it), so no search call is needed first —
// 1 point, not 2. `amount`/`unit` are caller-chosen (typically a fixed
// reference like 100 grams/100 milliliters, or the line's own unit for a
// count-based ingredient) so estimatedCost comes back already scaled to
// exactly what was asked — live-confirmed across weight, volume, and
// count/descriptor units (including messy real ones like "large head",
// "clove", "servings", and even a garbled "2-inch" — Spoonacular always
// either returns a plausible number or no cost data, never garbage).
//
// This is the PRIMARY grocery price source (Tavily is now a fallback only,
// see groceryData.ts) precisely because this field is a structured number,
// not a sentence to regex out of — sidesteps the exact failure mode found
// live 2026-07-24 (Tavily's LLM-synthesized answer sometimes contains more
// than one dollar figure, and a naive "first match" regex can grab the
// wrong one, e.g. a whole-turkey headline price instead of the per-100g
// figure actually being asked for).
export async function lookupIngredientCost(
  ingredientId: number,
  amount: number,
  unit?: string,
): Promise<IngredientCostLookup | null> {
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) {
    throw new SpoonacularRequestError("SPOONACULAR_API_KEY is not set");
  }

  const params = new URLSearchParams({ apiKey, amount: String(amount) });
  if (unit) params.set("unit", unit);

  let response: Response;
  try {
    response = await fetch(`https://api.spoonacular.com/food/ingredients/${ingredientId}/information?${params.toString()}`);
  } catch (err) {
    throw new SpoonacularRequestError(`Spoonacular request failed: ${(err as Error).message}`);
  }

  if (response.status === 402 || response.status === 429) {
    throw new SpoonacularQuotaError(`Spoonacular quota exceeded (HTTP ${response.status})`);
  }
  // Not a quota/outage case — an unknown id or a request Spoonacular can't
  // fulfill is expected/handled (falls through to the Tavily fallback),
  // same "return null, don't throw" convention as searchIngredient above.
  if (!response.ok) return null;

  let info: SpoonacularIngredientInformationResponse;
  try {
    info = await response.json();
  } catch (err) {
    throw new SpoonacularRequestError(`Spoonacular response was not valid JSON: ${(err as Error).message}`);
  }

  // A present-but-zero value is indistinguishable from "genuinely no cost
  // data" — both map to null rather than a fabricated $0.00 (same
  // precedent as lookupIngredientMacros's estimatedCostCentsPer100g).
  // Returns the object (with costCents: null) rather than null outright in
  // that case -- aisle can still be real and usable even when cost isn't.
  const value = info.estimatedCost?.value;
  const costCents = value && value > 0 ? Math.round(value) : null;
  return { costCents, aisle: parsePrimaryAisle(info.aisle) };
}

// Grocery-list categorization (grouping by aisle, e.g. "Produce", "Baking")
// — reuses the SAME ingredient information endpoint as lookupIngredientCost
// above (confirmed live 2026-07-25: the exact response Spoonacular already
// returns for cost lookups also carries a real `aisle` string, e.g.
// "Baking" for brown sugar, "Produce" for tomato), just without amount/unit
// params since aisle doesn't depend on quantity. Kept as its OWN function
// (not folded into lookupIngredientCost) because aisle categorization
// applies regardless of tier, cost lookups don't -- Free-tier users still
// need this standalone path since there's no cost lookup for them to piggy-
// back on. For Pro tier, groceryData.ts now avoids calling this a second
// time for the same ingredient id: it seeds ingredient_aisle_cache directly
// from lookupIngredientCost's own aisle field first (found live 2026-07-27
// this was a genuine duplicate call to this exact endpoint for every
// distinct ingredient on Pro tier -- up to ~150 avoidable extra requests
// per grocery-list computation), so this function only ever fires for ids
// that pricing didn't already resolve.
export async function lookupIngredientAisle(ingredientId: number): Promise<string | null> {
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) {
    throw new SpoonacularRequestError("SPOONACULAR_API_KEY is not set");
  }

  let response: Response;
  try {
    response = await fetch(
      `https://api.spoonacular.com/food/ingredients/${ingredientId}/information?${new URLSearchParams({ apiKey }).toString()}`,
    );
  } catch (err) {
    throw new SpoonacularRequestError(`Spoonacular request failed: ${(err as Error).message}`);
  }

  if (response.status === 402 || response.status === 429) {
    throw new SpoonacularQuotaError(`Spoonacular quota exceeded (HTTP ${response.status})`);
  }
  if (!response.ok) return null;

  let info: SpoonacularIngredientInformationResponse;
  try {
    info = await response.json();
  } catch (err) {
    throw new SpoonacularRequestError(`Spoonacular response was not valid JSON: ${(err as Error).message}`);
  }

  return parsePrimaryAisle(info.aisle);
}

// Spoonacular sometimes returns SEVERAL aisles for one ingredient, joined
// by ";" -- live-confirmed 2026-07-25: "BAKERY/BREAD;PASTA AND
// RICE;ETHNIC FOODS" for corn tortillas. Grouping by the raw string
// verbatim would put that one ingredient in its own garbled section
// instead of alongside every other bread/bakery item -- takes just the
// first (primary) aisle instead. A "/" within one segment (e.g.
// "BAKERY/BREAD") is left alone -- that reads as one compound label, the
// same way Spoonacular's own "Milk, Eggs, Other Dairy" uses a comma
// within a single aisle name, not a list to split further.
export function parsePrimaryAisle(raw: string | undefined): string | null {
  if (!raw) return null;
  const [first] = raw.split(";");
  const trimmed = first?.trim();
  return trimmed || null;
}

// Spoonacular's own ingredient-text NLP parser occasionally leaks
// non-ingredient fragments into extendedIngredients[].name -- live-audited
// 2026-07-31 against ~750 distinct real names that had passed through this
// pipeline, turning up 3 distinct failure shapes (~2.6% of names), plus a
// 4th found live 2026-08-01 during end-to-end testing of the deployed app:
//
// 1. A BARE connector/stopword with nothing else, from a mis-split
//    quantity RANGE (e.g. "1 to 2 jalapeños, chopped" -> a spurious entry
//    named just "to") -- live-confirmed rendering as "101.2g to" on a real
//    generated grocery list. Nothing to repair; dropped entirely.
// 2. A REAL ingredient with a leading connector or instruction verb glued
//    on from the same kind of mis-split (e.g. "of basil", "fry 2 strips
//    bacon") -- repaired by stripping the leading word rather than
//    dropped, since the ingredient after it is still real grocery data
//    worth keeping (and the plain remainder still text-overlaps its clean
//    counterpart elsewhere on the list via lineIdentity.ts's own
//    word-boundary matching, e.g. "2 chicken stock" still merges with
//    "chicken stock").
// 3. Multiple real ingredients concatenated into one run-on string with 2+
//    separate quantities embedded (e.g. "swiss cheese 8 ounces cheddar 2
//    eggs") -- genuinely unsalvageable without guessing where to split, so
//    dropped entirely rather than shown as one nonsense line. A rare
//    single-quantity descriptor (e.g. "corn tortillas 4\"") has only ONE
//    digit group and is never at risk.
// 4. A recipe title + serving-size label fragment, split on a colon (e.g.
//    "sundried tomato & artichoke tuna casserole: serves") -- live-
//    confirmed rendering as a genuine grocery-list line on a real
//    generated plan. This is exactly the "free-text leak with no fixed
//    pattern" shape nameRepair.ts's AI fallback exists for, but at 7 words
//    it fell one word short of that check's own trigger threshold (see
//    that file's AI_CHECK_WORD_THRESHOLD, lowered from 8 to 7 the same
//    day this was found) -- a real ingredient name essentially never
//    contains a literal colon, so this is a cheap, deterministic, zero-
//    AI-cost second line of defense for the same failure shape, not a
//    replacement for the threshold fix. Neither side of the colon is
//    trustworthy as a real ingredient (unlike shape 2's leading
//    connector), so this is dropped entirely rather than repaired.
const BARE_NON_INGREDIENT_WORDS = new Set(["to", "or", "and", "a", "an", "the", "of", "with", "for"]);
const LEADING_CONNECTOR = /^(?:to|of|and|from|for|with)\s+(.+)$/i;
// Imperative instruction verbs that would never legitimately lead a real
// ingredient's name (unlike a state-descriptor like "sliced"/"cooked",
// already handled by prefixStripFallback above) -- their presence means
// instruction text leaked into the ingredient-name field.
const LEADING_INSTRUCTION_VERB = /^(?:fry|boil|dissolve|mix|whisk|stir|simmer|heat|melt|combine|pour|add|bring|cover)\s+(.+)$/i;

export function repairOrRejectIngredientName(rawName: string): string | null {
  const trimmed = rawName.trim();
  if (!trimmed || BARE_NON_INGREDIENT_WORDS.has(trimmed.toLowerCase())) return null;

  const connectorMatch = LEADING_CONNECTOR.exec(trimmed);
  const verbMatch = connectorMatch ? null : LEADING_INSTRUCTION_VERB.exec(trimmed);
  const repaired = (connectorMatch ?? verbMatch)?.[1].trim() ?? trimmed;
  if (!repaired || BARE_NON_INGREDIENT_WORDS.has(repaired.toLowerCase())) return null;

  if (repaired.includes(":")) return null;

  const digitGroupCount = repaired.match(/\d+/g)?.length ?? 0;
  if (digitGroupCount >= 2) return null;

  return repaired;
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
    ingredients: (recipe.extendedIngredients ?? [])
      .flatMap((ing) => {
        const repairedName = repairOrRejectIngredientName(ing.name);
        return repairedName === null ? [] : [{ ...ing, name: repairedName }];
      })
      .map((ing) => ({
        id: ing.id,
        name: ing.name,
        amount: ing.amount,
        unit: ing.unit,
        metricAmount: ing.measures?.metric?.amount ?? ing.amount,
        metricUnit: ing.measures?.metric?.unitShort ?? ing.unit,
      })),
  };
}

// "View recipe" detail (mealplan/recipeInstructions.ts's cached wrapper) --
// a second, per-recipe call, deliberately NOT folded into complexSearch's
// addRecipeInformation above. A prior version of this comment claimed
// complexSearch already returns analyzedInstructions for every candidate,
// and that the separate call was purely to avoid wasting quota on the
// 20-60x candidates that never get claimed -- checked live 2026-07-27 by
// inspecting a raw complexSearch(addRecipeInformation=true,
// addRecipeNutrition=true) response directly: it does NOT include
// analyzedInstructions or instructions at all (only sourceUrl/
// spoonacularSourceUrl, nutrition, servings, etc.), even for the one
// candidate actually claimed. So there's no free data being discarded here
// -- a dedicated /information call is the ONLY way to get real steps, and
// eagerly calling it for every claimed slot (rather than only the ones a
// user actually opens) would spend quota on recipes most users never view,
// not save it. Confirmed this genuinely is the cheapest correct design.
interface SpoonacularRecipeInformationResponse {
  analyzedInstructions?: Array<{ steps?: Array<{ step?: string }> }>;
  sourceUrl?: string;
  spoonacularSourceUrl?: string;
}

export interface RecipeInstructions {
  steps: string[];
  sourceUrl: string | null;
}

// Never trusts the response shape blindly -- same "never fake progress"
// discipline as this codebase's other Spoonacular/LLM parsers. Exported
// (pure, no network) so it's directly unit-testable rather than the fetch
// call itself, matching aggregate.ts/identityMatch.ts/unitConversion.ts's
// existing convention.
export function parseRecipeInformation(raw: unknown): RecipeInstructions {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as SpoonacularRecipeInformationResponse;
  const sections = Array.isArray(body.analyzedInstructions) ? body.analyzedInstructions : [];
  const steps = sections
    .flatMap((section) => (Array.isArray(section.steps) ? section.steps : []))
    .map((s) => s.step)
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  const sourceUrl = body.sourceUrl || body.spoonacularSourceUrl || null;
  return { steps, sourceUrl };
}

export async function fetchRecipeInstructions(recipeId: number): Promise<RecipeInstructions | null> {
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) {
    throw new SpoonacularRequestError("SPOONACULAR_API_KEY is not set");
  }

  let response: Response;
  try {
    response = await fetch(
      `https://api.spoonacular.com/recipes/${recipeId}/information?${new URLSearchParams({ apiKey }).toString()}`,
    );
  } catch (err) {
    throw new SpoonacularRequestError(`Spoonacular request failed: ${(err as Error).message}`);
  }

  if (response.status === 402 || response.status === 429) {
    throw new SpoonacularQuotaError(`Spoonacular quota exceeded (HTTP ${response.status})`);
  }
  // An unknown/removed recipe id or a request Spoonacular can't fulfill is
  // expected/handled (the UI falls back to "ingredients only"), same
  // "return null, don't throw" convention as searchIngredient/
  // lookupIngredientCost above.
  if (!response.ok) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new SpoonacularRequestError(`Spoonacular response was not valid JSON: ${(err as Error).message}`);
  }

  return parseRecipeInformation(body);
}
