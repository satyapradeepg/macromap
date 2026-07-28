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
import { lookupIngredientMacrosStatic, MAX_REALISTIC_AMOUNT_G, DEFAULT_MAX_REALISTIC_AMOUNT_G } from "./staticIngredientMacros";

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

// Sizes the add-on toward whichever is smallest of: the 20%-calorie
// allowance below, the actual remaining gap for the targeted macro
// (`neededAmount`, 2026-07-28), and the realism ceiling above — never uses
// more than the real gap needs, so an add-on aimed at one macro (e.g.
// carbs) doesn't incidentally overshoot the OTHERS (e.g. fat) by more than
// necessary just because it always maxed out before. Reconciliation still
// re-sums actuals after each attempt and keeps going (up to the shared
// retry budget) until the gap closes or the budget runs out, falling back
// to a full recipe requery for whatever's left — a single add-on still
// isn't expected to close a large gap alone, it's just no longer sized
// past what's actually needed.
const NO_PANTRY_PRICE_PREFERENCE: PantryPriceContext = { pantryItemNames: [], budgetAware: false };

// The ingredient lookup's per-100g fields are named `caloriesPer100g`/
// `proteinGPer100g`/etc., not indexable by a MacroKey string directly.
function macroPer100g(lookup: IngredientMacroLookup, macro: MacroKey): number {
  switch (macro) {
    case "calories":
      return lookup.caloriesPer100g;
    case "proteinG":
      return lookup.proteinGPer100g;
    case "carbsG":
      return lookup.carbsGPer100g;
    case "fatG":
      return lookup.fatGPer100g;
  }
}

export async function buildAddonForSlot(
  slotCalories: number,
  gap: MacroGapDirection,
  fetchIngredientMacros: FetchIngredientMacrosFn,
  ctx: DietaryContext,
  pantryPriceCtx: PantryPriceContext = NO_PANTRY_PRICE_PREFERENCE,
  // Absolute amount of `gap.macro` still needed to reach the true target
  // (not just the nearest tolerance-band edge — see orchestrate.ts's call
  // sites and reconciliation.ts's `amountNeededFor`). Defaults to Infinity
  // so any caller that doesn't pass one reproduces the pre-2026-07-28
  // always-max-to-cap behavior exactly (existing tests rely on this).
  neededAmount: number = Infinity,
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
  // contribution never exceeds whichever ceiling is smallest, even after
  // rounding: the 20%-of-calories allowance, the actual gap still needed
  // for the targeted macro, or (checked just below) the realism ceiling.
  const capCalories = slotCalories * MAX_ADDON_CALORIE_FRACTION;
  const capAmountG = (capCalories / lookup.caloriesPer100g) * 100;
  const neededAmountG = (neededAmount / macroPer100g(lookup, gap.macro)) * 100;
  const amountG = Math.floor(Math.min(capAmountG, neededAmountG) / 5) * 5;
  if (amountG < MIN_ADDON_AMOUNT_G) return null;

  // Realistic-portion ceiling (shared with snackComposition.ts, see
  // staticIngredientMacros.ts) -- the 20%-of-calories cap above has no
  // opinion on gram amount, so a low-density ingredient on a large-calorie
  // slot had nothing else stopping an unrealistic serving (e.g. a
  // several-hundred-gram banana addition). Reject, don't clamp -- same
  // "skip and let reconciliation try something else" fallback as every
  // other rejection path in this function.
  const maxRealisticAmountG = MAX_REALISTIC_AMOUNT_G[lookup.name] ?? DEFAULT_MAX_REALISTIC_AMOUNT_G;
  if (amountG > maxRealisticAmountG) return null;

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
