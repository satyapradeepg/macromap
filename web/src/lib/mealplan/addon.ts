// Epic E2 (F3) — snack/add-on gap-closer. Pure given an injected lookup
// function (mirrors cascade.ts's FetchCandidatesFn pattern): never touches
// `fetch` directly, so it's testable with a fake IngredientMacroLookup.
//
// Fully deterministic — no LLM call anywhere in this file. Selecting which
// ingredient to add is a fixed macro->ingredient-name lookup, not a
// judgment call; macros are always resolved via Spoonacular's real
// ingredient data (docs/PRD-MacroMap.md 7.3 F3 grounding rule), same as the
// (separate, not-yet-built) AI composition fallback.

import type { MacroGapDirection, MacroKey } from "./reconciliation";
import { isKnownIngredientUnsafeFor, type DietaryContext } from "./ingredientSafety";
import { rankByPantryAndPrice, type PantryPriceContext } from "./pantryPricePreference";
import { lookupIngredientMacrosStatic } from "./staticIngredientMacros";

export interface IngredientMacroLookup {
  id: number;
  name: string;
  caloriesPer100g: number;
  proteinGPer100g: number;
  carbsGPer100g: number;
  fatGPer100g: number;
  estimatedCostCentsPer100g: number | null;
}

export type FetchIngredientMacrosFn = (query: string) => Promise<IngredientMacroLookup | null>;

export interface SlotAddon {
  ingredientName: string;
  spoonacularIngredientId: number;
  amountG: number;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  estimatedCostCents: number | null;
}

// Per-macro fallback list (PRD 7.3 F3: "fruit, nuts, yogurt, protein
// powder, etc.") — fixed, deterministic candidates rather than an
// open-ended search, so results stay stable/testable. Ordered
// best-fit-first (e.g. greek yogurt is the most protein-dense of the
// protein options); buildAddonForSlot tries each in order and skips any
// that's unsafe for the profile (ingredientSafety.ts) — found and fixed
// July 15 2026 after confirming this file never checked allergies/diet at
// all, meaning e.g. a nut allergy could previously get served almonds.
// Reuses the exact same ingredient set as snackComposition.ts's
// INGREDIENT_POOL (just macro-ordered rather than role-grouped), not a
// separate list, so there's one place that defines "the fixed pool."
// proteinG/fatG widened alongside INGREDIENT_POOL (audit round 2, July 15
// 2026) -- see that file's comment for why (vegan+nut+soy allergy
// stacking left both roles with zero safe options).
export const ADDON_INGREDIENT_OPTIONS_BY_MACRO: Record<MacroKey, string[]> = {
  proteinG: ["greek yogurt", "cottage cheese", "protein powder", "pea protein powder", "hemp seeds"],
  carbsG: ["banana", "apple", "orange"],
  fatG: ["almonds", "walnuts", "peanut butter", "sunflower seed butter", "chia seeds"],
  calories: ["peanut butter", "walnuts", "almonds", "sunflower seed butter", "chia seeds"],
};

// PRD 7.3 F3: "capped at... ≤15-20% of that meal's calories" — uses the top
// of that range (not the 17.5% midpoint originally chosen) as a hard
// ceiling on the add-on's own calorie contribution, still reading as a
// snack rather than "a second meal." Raised from 17.5%->20% after a real
// generation landed 4.2g of carbs short of the weekly band with 17.5% —
// the extra headroom closes gaps like that one without changing anything
// about what counts as realistic (still within PRD's stated range).
const MAX_ADDON_CALORIE_FRACTION = 0.2;

// Below this, an add-on isn't worth attaching (real ingredients have low
// but nonzero minimums due to rounding) — treated the same as a failed
// lookup so reconciliation falls through to the slack-meal requery.
const MIN_ADDON_AMOUNT_G = 10;

// Sizes the add-on to use the FULL calorie allowance for the target macro's
// ingredient (maximizing its contribution within the realism cap) rather
// than solving for the exact remaining weekly gap — a single snack can't
// realistically close a large weekly deficit by itself, so this is a
// deliberately incremental, capped step: reconciliation re-sums actuals
// after each attempt and keeps going (up to the shared retry budget) until
// the gap closes or the budget runs out, falling back to a full recipe
// requery for whatever's left.
const NO_PANTRY_PRICE_PREFERENCE: PantryPriceContext = { pantryItemNames: [], budgetAware: false };

export async function buildAddonForSlot(
  slotCalories: number,
  gap: MacroGapDirection,
  fetchIngredientMacros: FetchIngredientMacrosFn,
  ctx: DietaryContext,
  pantryPriceCtx: PantryPriceContext = NO_PANTRY_PRICE_PREFERENCE,
): Promise<SlotAddon | null> {
  // Safety first (unchanged): filter to candidates safe for this profile
  // before considering pantry/price preference at all.
  const safeCandidates = ADDON_INGREDIENT_OPTIONS_BY_MACRO[gap.macro].filter(
    (candidate) => isKnownIngredientUnsafeFor(candidate, ctx) === null,
  );

  // Pantry/price reordering (retrofitted July 15 2026) uses the static
  // table's pinned cost — NOT a live fetch — purely to decide which
  // order to TRY candidates in, preserving the "fetch until one resolves"
  // efficiency this function has always had. All of ADDON_INGREDIENT_
  // OPTIONS_BY_MACRO's candidates are from the known fixed pool, so this
  // is always available (no need to fall back to a live cost peek here).
  const { ordered } = rankByPantryAndPrice(
    safeCandidates.map((name) => ({ name, costCentsPer100g: lookupIngredientMacrosStatic(name)?.estimatedCostCentsPer100g ?? null })),
    pantryPriceCtx,
  );

  // Tries each candidate in the (now preference-ordered) list, skipping
  // straight to the next if a lookup fails to resolve — never falls
  // through to an unsafe option even if every safe one fails to resolve
  // (a genuine "no add-on this time," same as today's null-lookup case).
  let lookup = null;
  for (const candidate of ordered) {
    lookup = await fetchIngredientMacros(candidate.name);
    if (lookup) break;
  }
  if (!lookup || lookup.caloriesPer100g <= 0) return null;

  // Floors to the nearest 5g (not round-to-nearest) so the add-on's real
  // calorie contribution never exceeds capCalories, even after rounding.
  const capCalories = slotCalories * MAX_ADDON_CALORIE_FRACTION;
  const amountG = Math.floor((capCalories / lookup.caloriesPer100g) * 100 / 5) * 5;
  if (amountG < MIN_ADDON_AMOUNT_G) return null;

  const scale = amountG / 100;
  return {
    ingredientName: lookup.name,
    spoonacularIngredientId: lookup.id,
    amountG,
    caloriesKcal: lookup.caloriesPer100g * scale,
    proteinG: lookup.proteinGPer100g * scale,
    carbsG: lookup.carbsGPer100g * scale,
    fatG: lookup.fatGPer100g * scale,
    estimatedCostCents: lookup.estimatedCostCentsPer100g !== null ? lookup.estimatedCostCentsPer100g * scale : null,
  };
}
