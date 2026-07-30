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
  // Added July 15 2026 (audit round 2) alongside ingredientSafety.ts's
  // dietaryStyles-aware check -- false for all 9 pool ingredients today
  // (none of them are wheat/gluten-based), so this has no observable
  // effect yet, but closes a real completeness gap for gluten_free and
  // future-proofs against the pool ever growing to include something
  // gluten-containing (e.g. a granola bar).
  containsGluten: boolean;
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
    containsGluten: false,
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
    containsGluten: false,
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
    containsGluten: false,
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
    containsGluten: false,
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
    containsGluten: false,
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
    containsGluten: false,
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
    containsGluten: false,
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
    containsGluten: false,
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
    containsGluten: false,
    veganCompliant: true,
  },

  // Added July 15 2026 (audit round 2, finding: vegan + nut allergy + soy
  // allergy collapsed a plan to 17% of target because the protein and fat
  // roles each had zero safe options left -- greek yogurt/cottage cheese/
  // protein powder are all dairy- or soy-tagged, almonds/walnuts/peanut
  // butter are all nut-tagged). Two per starved role, not one -- a single
  // addition would leave exactly 1 safe option for this profile,
  // colliding with the exact "collapses to 1, no rotation" bug already
  // found and fixed for pantry/budget preference earlier the same day.
  // Real data, fetched live the same way the original 9 were (search +
  // information, amount=100/unit=grams).
  "pea protein powder": {
    id: 98890,
    name: "pea protein powder",
    caloriesPer100g: 363.63,
    proteinGPer100g: 72.72,
    carbsGPer100g: 3.03,
    fatGPer100g: 6.06,
    estimatedCostCentsPer100g: 240.0,
    containsDairy: false,
    containsNut: false,
    containsSoy: false,
    containsGluten: false,
    veganCompliant: true,
  },
  "hemp seeds": {
    id: 93602,
    name: "hemp seeds",
    caloriesPer100g: 580,
    proteinGPer100g: 37,
    carbsGPer100g: 7,
    fatGPer100g: 45,
    estimatedCostCentsPer100g: 339.29,
    containsDairy: false,
    containsNut: false,
    containsSoy: false,
    containsGluten: false,
    veganCompliant: true,
  },
  "sunflower seed butter": {
    id: 98928,
    name: "sunflower seed butter",
    caloriesPer100g: 579,
    proteinGPer100g: 19.7,
    carbsGPer100g: 27.4,
    fatGPer100g: 47.7,
    estimatedCostCentsPer100g: 166.08,
    containsDairy: false,
    containsNut: false,
    containsSoy: false,
    containsGluten: false,
    veganCompliant: true,
  },
  "chia seeds": {
    id: 12006,
    name: "chia seeds",
    caloriesPer100g: 486,
    proteinGPer100g: 16.54,
    carbsGPer100g: 42.12,
    fatGPer100g: 30.74,
    estimatedCostCentsPer100g: 178.57,
    containsDairy: false,
    containsNut: false,
    containsSoy: false,
    containsGluten: false,
    veganCompliant: true,
  },

  // Added 2026-07-30 (15-profile comprehensive live audit, engine-comprehensive-
  // test-2026-07-30.md): the carb role's original 3-option pool (banana/apple/
  // orange) was never widened in the July 15 2026 audit round that widened
  // protein/fat to 5 each -- found live that this is a real, structural gap,
  // not just an oversight. Banana/apple/orange top out at 33-57g deliverable
  // carbs within their own realistic-portion caps (MAX_REALISTIC_AMOUNT_G
  // below), but a snack's own carb target regularly needs 68g+ for a
  // higher-calorie profile (live-confirmed: a bulk-goal profile's snack1
  // needed 68.1g carbs, and EVERY fruit option would have needed 300-580g to
  // close it -- all three silently return null, since sizeIngredientForGap
  // rejects any amount over its realistic cap). This is what actually drove
  // the "fat looks like it's overshooting" appearance found in the audit: fat
  // wasn't overshooting its own target, carbs (and therefore total calories)
  // were undershooting far more severely, inflating fat's apparent share.
  // Real data, fetched live the same way the original 9 and the July 15
  // 5-widening were (search + information, amount=100/unit=grams).
  oats: {
    id: 8120,
    name: "oats",
    caloriesPer100g: 379,
    proteinGPer100g: 13.2,
    carbsGPer100g: 67.7,
    fatGPer100g: 6.52,
    estimatedCostCentsPer100g: 39.29,
    containsDairy: false,
    containsNut: false,
    containsSoy: false,
    // Pure oats are naturally gluten-free, but commercial oats are routinely
    // cross-contaminated with wheat during farming/milling unless explicitly
    // "certified gluten-free" -- this app has no way to distinguish that at
    // the ingredient-name level, so conservatively tagged true, same
    // "ambiguous -> excluded" default this file already documents for
    // protein powder's dairy/soy tagging above.
    containsGluten: true,
    veganCompliant: true,
  },
  dates: {
    id: 9087,
    name: "dates",
    caloriesPer100g: 282,
    proteinGPer100g: 2.45,
    carbsGPer100g: 75.0,
    fatGPer100g: 0.39,
    estimatedCostCentsPer100g: 114.29,
    containsDairy: false,
    containsNut: false,
    containsSoy: false,
    containsGluten: false,
    veganCompliant: true,
  },

  // Added 2026-07-30 (variety/repetition follow-up to the same comprehensive
  // audit): the protein role bottlenecks to just 2 safe options
  // (pea protein powder, hemp seeds) under a vegan restriction alone --
  // greek yogurt/cottage cheese/protein powder are all dairy-tagged, and a
  // stacked soy allergy (the exact H1 test profile) also removes protein
  // powder's soy tag, still leaving 2. With only 2 real rotation options
  // across 14 weekly snack slots, even perfect rotation guarantees each one
  // appears ~7 times -- live-confirmed in the audit ("Hemp Seeds + Orange"
  // appearing 7x for a dairy-free profile, "Pea Protein Powder + Sunflower
  // Seed Butter" 7x for vegan+nut). Real data, fetched live the same way as
  // every other pool addition (search + information, amount=100/unit=grams).
  "pumpkin seeds": {
    id: 12014,
    name: "pumpkin seeds",
    caloriesPer100g: 559,
    proteinGPer100g: 30.23,
    carbsGPer100g: 10.71,
    fatGPer100g: 49.05,
    estimatedCostCentsPer100g: 178.57,
    containsDairy: false,
    // A seed, not a tree nut or peanut -- same classification as the
    // already-present hemp/chia/sunflower seed entries, none of which are
    // tagged containsNut. Safe for a nut allergy, safe for soy allergy,
    // gluten-free, vegan -- the widest-safety addition available, closing
    // the gap for the SAME worst-case profile (vegan + soy, H1) the carb
    // pool was widened for two commits ago.
    containsNut: false,
    containsSoy: false,
    containsGluten: false,
    veganCompliant: true,
  },
  edamame: {
    id: 99296,
    name: "edamame",
    caloriesPer100g: 121.62,
    proteinGPer100g: 9.46,
    carbsGPer100g: 13.51,
    fatGPer100g: 3.34,
    estimatedCostCentsPer100g: 75.0,
    containsDairy: false,
    containsNut: false,
    // Real soybeans -- unlike pumpkin seeds above, does NOT help a soy-
    // allergic profile (correctly excluded there), but adds real rotation
    // headroom for the more common case of vegan-without-soy-allergy,
    // where the pool would otherwise still bottleneck to 3.
    containsSoy: true,
    containsGluten: false,
    veganCompliant: true,
  },
};

export function lookupIngredientMacrosStatic(query: string): StaticIngredientMacro | null {
  return STATIC_INGREDIENT_MACROS[query.toLowerCase().trim()] ?? null;
}

// Per-ingredient realistic-portion ceiling, shared by every path that sizes
// one of this fixed 17-ingredient pool to close a macro gap (snackComposition.ts's
// composeSnack, addon.ts's buildAddonForSlot) -- moved here from
// snackComposition.ts (2026-07-28) so both consumers read one table instead
// of risking two definitions drifting apart.
//
// Originally added to snackComposition.ts (audit item #3, 2026-07-21 spec):
// that file had no upper bound at all -- a low-density carb like orange
// (11.8g carb/100g) sizing to close a genuinely large carb gap could reach
// ~340g with nothing catching it. Deliberately PER-INGREDIENT, not per-role
// like aiMealComposition.ts's PORTION_BOUNDS_G -- that file has to use one
// generic bound per role because it's grounding arbitrary LLM-proposed
// ingredient names it can't enumerate in advance. This pool is the opposite
// case: a small, fully known, fixed set of 17 real foods, and macro density
// varies too widely WITHIN a role for one shared ceiling to work -- protein
// powder (83g protein/100g) and greek yogurt (10g protein/100g) are both
// "protein role," but a per-role max loose enough to allow a normal ~200g
// yogurt serving would also wave through an absurd ~200g of protein powder
// (166g protein, several days' worth of scoops in one snack/addon). An
// explicit editorial call per ingredient, not a density-derived formula, so
// it can't silently drift wrong as the pool's foods change. A rejection here
// just skips that ingredient's contribution (both callers already treat a
// null result as "skip, try the next thing") -- never breaks the whole
// snack/addon/plan.
export const MAX_REALISTIC_AMOUNT_G: Record<string, number> = {
  "greek yogurt": 300,
  // 260g+ is a real, already-validated output for snackComposition.ts's own
  // reference 29g-protein snack target (roughly 1.15 cups) -- not the
  // unrealistic case this bound exists to catch. 300, not 250.
  "cottage cheese": 300,
  "protein powder": 60,
  "pea protein powder": 60,
  "hemp seeds": 50,
  banana: 250,
  apple: 300,
  // Needs headroom up to ~260g for the same reference target (a realistic
  // ~2-orange snack), while still catching the audit's actual ~340g problem
  // case. 280, not 250.
  orange: 280,
  almonds: 60,
  "peanut butter": 50,
  walnuts: 60,
  "sunflower seed butter": 50,
  "chia seeds": 40,
  // Added with the 2026-07-30 carb-pool widening. 150g dry oats is a large
  // but real single-serving bowl of oatmeal (delivers up to ~101g carbs --
  // comfortably covers the ~68g gap that motivated adding it, without
  // waving through an absurd amount). 120g dates is roughly 7-8 medjool
  // dates, a generous but real handful (up to ~90g carbs).
  oats: 150,
  dates: 120,
  // Added with the 2026-07-30 protein-pool widening (variety/repetition
  // follow-up). Pumpkin seeds are as dense as almonds/walnuts -- same 60g
  // cap. Edamame is far less dense; 150g is a real, generous "bowl of
  // edamame pods" snack portion (delivers up to ~14g protein).
  "pumpkin seeds": 60,
  edamame: 150,
};
// Safety net for a future pool addition someone forgets to add a bound for
// above -- fails closed (a real, if conservative, cap) rather than silently
// reproducing this exact gap for the new ingredient.
export const DEFAULT_MAX_REALISTIC_AMOUNT_G = 200;

// Display-only realism note (2026-07-27, extended 2026-07-30 for oats and edamame): 6 of the 17 pool ingredients
// aren't things a person actually eats standalone in the sized amount --
// protein powder/pea protein powder need a liquid, chia/hemp seeds are
// normally a topping/mix-in, not a bowl of dry seeds. The macros are real
// either way; this only fixes how the amount is DESCRIBED.
//
// Every note here points at water (zero macro impact) or at something
// ALREADY tracked in the same context (the recipe an addon sits next to,
// or this same composed snack's other ingredients) -- never at an
// untracked outside food like milk/yogurt/oats. Suggesting those would
// silently let someone eat more than the app is tracking, exactly the
// "recorded macros don't match what's actually eaten" failure class this
// whole session has been fixing elsewhere (sumWithAddons, reconciliation).
export type PrepNoteContext = "addon" | "snack";

export function prepNoteFor(
  ingredientName: string,
  context: PrepNoteContext,
  hasOtherTrackedIngredients: boolean,
): string | null {
  const name = ingredientName.toLowerCase().trim();

  if (name === "protein powder" || name === "pea protein powder") {
    // Water only, never offered alongside milk -- milk carries real
    // macros that aren't part of the sized/tracked amount.
    return "mix with water";
  }

  // Added alongside the 2026-07-30 carb-pool widening -- a sized amount of
  // dry oats (e.g. 100g+) isn't eaten standalone any more than protein
  // powder is; real prep is cooking it into oatmeal with water, same
  // zero-extra-macro note pattern as protein powder above. Dates need no
  // note -- eaten standalone like the existing banana/apple/orange options.
  if (name === "oats") {
    return "cook with water as oatmeal";
  }

  // Added alongside the 2026-07-30 protein-pool widening -- same "isn't
  // eaten standalone in the sized raw amount" gap as oats above, missed
  // when edamame was first added and only caught when asked directly
  // whether people actually snack on it: yes, but on the STEAMED beans,
  // not raw/frozen ones. Real prep is a few minutes in water, zero extra
  // macros, same pattern as oats/protein powder.
  if (name === "edamame") {
    return "steam or boil a few minutes";
  }

  if (name === "chia seeds" || name === "hemp seeds") {
    // An addon always sits next to a real recipe slot, so there's always
    // something already-tracked to sprinkle it over.
    if (context === "addon") return "sprinkle over your meal";
    if (hasOtherTrackedIngredients) return "sprinkle over the rest of this snack";
    // Standalone in a composed snack (the other 2 roles didn't resolve) --
    // chia genuinely gels in plain water (real chia-pudding prep, still
    // zero extra macros); hemp seeds have no equivalent zero-macro
    // standalone prep, so the honest note doesn't pretend one exists.
    return name === "chia seeds" ? "soak in water" : "best paired with a meal you're already having";
  }

  return null;
}
