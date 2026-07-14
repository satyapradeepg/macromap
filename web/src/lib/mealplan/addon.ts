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

export interface IngredientMacroLookup {
  id: number;
  name: string;
  caloriesPer100g: number;
  proteinGPer100g: number;
  carbsGPer100g: number;
  fatGPer100g: number;
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
}

// One representative single-ingredient add-on per macro (PRD 7.3 F3: "fruit,
// nuts, yogurt, protein powder, etc.") — a fixed, deterministic choice per
// macro rather than an open-ended search, so results are stable/testable.
const ADDON_INGREDIENT_BY_MACRO: Record<MacroKey, string> = {
  proteinG: "greek yogurt",
  carbsG: "banana",
  fatG: "almonds",
  calories: "peanut butter",
};

// PRD 7.3 F3: "capped at... ≤15-20% of that meal's calories" — 17.5% is the
// midpoint, applied as a hard ceiling on the add-on's own calorie
// contribution so it always reads as a snack, never "a second meal."
const MAX_ADDON_CALORIE_FRACTION = 0.175;

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
export async function buildAddonForSlot(
  slotCalories: number,
  gap: MacroGapDirection,
  fetchIngredientMacros: FetchIngredientMacrosFn,
): Promise<SlotAddon | null> {
  const query = ADDON_INGREDIENT_BY_MACRO[gap.macro];
  const lookup = await fetchIngredientMacros(query);
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
  };
}
