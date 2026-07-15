// Epic E2 (F3) — pinned macro data for the fixed 9-ingredient snack/add-on
// pool (snackComposition.ts's INGREDIENT_POOL). These 9 names are the ONLY
// queries addon.ts and the snack composer ever make against Spoonacular's
// ingredient endpoints — not user- or plan-specific, so re-fetching them
// live on every single generation (and every snack swap) was pure waste:
// live-confirmed ~2 real points/ingredient (search + information calls),
// ~18 points per generation just for this fixed pool, before any recipe
// search or reconciliation cost. Found and fixed July 15 2026 after a
// live extreme-profile test burned an entire 50-point free-tier key on
// one generation attempt, almost entirely through this path.
//
// Values below were fetched live from Spoonacular's real
// /food/ingredients/search + /food/ingredients/{id}/information endpoints
// (same fields, same amount=100/unit=grams call `lookupIngredientMacros`
// makes) on July 15 2026 — real data, not fabricated, just pinned instead
// of re-queried. Refresh by re-running those same two calls only if
// snackComposition.ts's INGREDIENT_POOL name list ever changes.
//
// estimatedCostCentsPer100g added same day, retrofitting pantry/price
// awareness into this system after confirming it had neither (unlike the
// recipe-search path's real pantryOverlapDeduction/budgetCompliant
// mechanisms). Spoonacular's ingredient information endpoint returns a
// real `estimatedCost` field by default on the exact same call already
// made for macros — no extra API cost to add this.
export interface StaticIngredientMacro {
  id: number;
  name: string;
  caloriesPer100g: number;
  proteinGPer100g: number;
  carbsGPer100g: number;
  fatGPer100g: number;
  estimatedCostCentsPer100g: number;
  // Safety tags for ingredientSafety.ts — curated by hand for this fixed,
  // known 9-ingredient set (not inferred from the name string), so they're
  // exact rather than a best-effort keyword guess. containsNut covers both
  // tree nuts and peanuts, matching this app's single "nuts" allergy
  // preset (F2 doesn't distinguish the two). Ambiguous ingredients default
  // to the SAFER (excluded) tag rather than assuming a specific
  // formulation: "protein powder" could resolve to a whey (dairy), soy, or
  // plant-based product depending on which real one Spoonacular's search
  // happens to return, so it's conservatively tagged as both
  // containsDairy and containsSoy, and not vegan-compliant.
  containsDairy: boolean;
  containsNut: boolean;
  containsSoy: boolean;
  veganCompliant: boolean;
}

export const STATIC_INGREDIENT_MACROS: Record<string, StaticIngredientMacro> = {
  "greek yogurt": {
    id: 1256,
    name: "greek yogurt",
    caloriesPer100g: 61,
    proteinGPer100g: 10.3,
    carbsGPer100g: 3.64,
    fatGPer100g: 0.37,
    estimatedCostCentsPer100g: 71.43,
    containsDairy: true,
    containsNut: false,
    containsSoy: false,
    veganCompliant: false,
  },
  "cottage cheese": {
    id: 1012,
    name: "cottage cheese",
    caloriesPer100g: 98,
    proteinGPer100g: 11.1,
    carbsGPer100g: 3.38,
    fatGPer100g: 4.3,
    estimatedCostCentsPer100g: 50.0,
    containsDairy: true,
    containsNut: false,
    containsSoy: false,
    veganCompliant: false,
  },
  "protein powder": {
    id: 99239,
    name: "protein powder",
    caloriesPer100g: 400,
    proteinGPer100g: 83.33,
    carbsGPer100g: 10,
    fatGPer100g: 6.67,
    estimatedCostCentsPer100g: 278.57,
    // Conservative: formulation is unknown/ambiguous, so treat it as both
    // dairy (whey) and soy for safety purposes rather than assuming plant-based.
    containsDairy: true,
    containsNut: false,
    containsSoy: true,
    veganCompliant: false,
  },
  banana: {
    id: 9040,
    name: "banana",
    caloriesPer100g: 89,
    proteinGPer100g: 1.09,
    carbsGPer100g: 22.8,
    fatGPer100g: 0.33,
    estimatedCostCentsPer100g: 13.33,
    containsDairy: false,
    containsNut: false,
    containsSoy: false,
    veganCompliant: true,
  },
  apple: {
    id: 9003,
    name: "apple",
    caloriesPer100g: 52,
    proteinGPer100g: 0.26,
    carbsGPer100g: 13.8,
    fatGPer100g: 0.17,
    estimatedCostCentsPer100g: 33.11,
    containsDairy: false,
    containsNut: false,
    containsSoy: false,
    veganCompliant: true,
  },
  orange: {
    id: 9200,
    name: "orange",
    caloriesPer100g: 47,
    proteinGPer100g: 0.94,
    carbsGPer100g: 11.8,
    fatGPer100g: 0.12,
    estimatedCostCentsPer100g: 22.22,
    containsDairy: false,
    containsNut: false,
    containsSoy: false,
    veganCompliant: true,
  },
  almonds: {
    id: 12061,
    name: "almonds",
    caloriesPer100g: 579,
    proteinGPer100g: 21.2,
    carbsGPer100g: 21.6,
    fatGPer100g: 49.9,
    estimatedCostCentsPer100g: 178.57,
    containsDairy: false,
    containsNut: true,
    containsSoy: false,
    veganCompliant: true,
  },
  "peanut butter": {
    id: 16098,
    name: "peanut butter",
    caloriesPer100g: 597,
    proteinGPer100g: 22.5,
    carbsGPer100g: 22.3,
    fatGPer100g: 51.1,
    estimatedCostCentsPer100g: 35.71,
    containsDairy: false,
    containsNut: true,
    containsSoy: false,
    veganCompliant: true,
  },
  walnuts: {
    id: 12155,
    name: "walnuts",
    caloriesPer100g: 654,
    proteinGPer100g: 15.2,
    carbsGPer100g: 13.7,
    fatGPer100g: 65.2,
    estimatedCostCentsPer100g: 239.29,
    containsDairy: false,
    containsNut: true,
    containsSoy: false,
    veganCompliant: true,
  },
};

export function lookupIngredientMacrosStatic(query: string): StaticIngredientMacro | null {
  return STATIC_INGREDIENT_MACROS[query.toLowerCase().trim()] ?? null;
}
