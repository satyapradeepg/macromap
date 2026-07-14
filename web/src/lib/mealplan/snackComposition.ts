// Epic E2 rework — F6/F3 real snack slots (snack1/snack2). Composes 2-3
// whole-food ingredients to hit a snack slot's target macros, instead of
// searching Spoonacular's recipe corpus (live-tested: type=snack is
// dominated by low-protein soups/dips/salads, as few as 8 real matches at
// Prospre-scale snack targets — see targets.ts's SLOT_MECHANISM comment).
//
// Fully deterministic — no LLM call, same grounding rule as addon.ts:
// every macro comes from Spoonacular's real ingredient data, never
// estimated. Sequential greedy algorithm, same philosophy as addon.ts's
// single-ingredient sizing just chained three times: size a protein-role
// ingredient to hit the protein target, then a carb-role ingredient to
// close whatever carb gap remains, then a fat-role ingredient to close
// whatever fat gap remains. Verified by hand against real ingredient data
// (greek yogurt + banana + almonds) before writing this: lands within
// ~5-15% on every macro for a real 337kcal/29g-protein snack target.
//
// Cost design: ingredient macros are looked up from a POOL fetched ONCE
// per generation (orchestrate.ts), not per snack slot — with 14 snack
// slots/week, a fresh 3-ingredient lookup per slot would cost ~84
// Spoonacular points/plan (3 lookups x 2pts x 14 slots) versus ~18 points
// for the whole week (9 pool ingredients x 2pts, looked up once and
// reused). See INGREDIENT_POOL below.

import type { MacroTargets } from "./targets";

export type MacroRole = "protein" | "carb" | "fat";

export interface IngredientMacroLookup {
  id: number;
  name: string;
  caloriesPer100g: number;
  proteinGPer100g: number;
  carbsGPer100g: number;
  fatGPer100g: number;
}

// Small, fixed pool per role — real-food, not exotic, matching what
// Prospre's own snack examples actually look like (protein shake/yogurt,
// banana/orange, occasionally nuts). 3 options per role gives real
// rotation across a week's 14 snack slots without an unbounded lookup
// cost — all 9 are fetched once per generation, not per slot.
export const INGREDIENT_POOL: Record<MacroRole, string[]> = {
  protein: ["greek yogurt", "cottage cheese", "protein powder"],
  carb: ["banana", "apple", "orange"],
  fat: ["almonds", "peanut butter", "walnuts"],
};

export function allPoolIngredientNames(): string[] {
  return [...INGREDIENT_POOL.protein, ...INGREDIENT_POOL.carb, ...INGREDIENT_POOL.fat];
}

// Deterministic rotation (day index x slot position, not Math.random —
// this is a real backend generation path, same determinism requirement as
// everything else in mealplan/) so a week's 14 snack slots don't all use
// the identical 3 ingredients.
function pickFromPool(role: MacroRole, varietySeed: number): string {
  const options = INGREDIENT_POOL[role];
  return options[varietySeed % options.length];
}

export interface ComposedIngredient {
  ingredientName: string;
  spoonacularIngredientId: number;
  amountG: number;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface ComposedSnack {
  ingredients: ComposedIngredient[];
  totalCalories: number;
  totalProteinG: number;
  totalCarbsG: number;
  totalFatG: number;
}

const MIN_INGREDIENT_AMOUNT_G = 10;

// Sizes one ingredient to close a specific macro gap (protein/carbs/fat),
// rounding down to the nearest 5g and skipping it entirely if that rounds
// below a sensible minimum — same pattern as addon.ts's buildAddonForSlot.
function sizeIngredientForGap(
  lookup: IngredientMacroLookup,
  macroPer100g: number,
  gapNeeded: number,
): ComposedIngredient | null {
  if (macroPer100g <= 0 || gapNeeded <= 0) return null;
  const amountG = Math.floor(((gapNeeded / macroPer100g) * 100) / 5) * 5;
  if (amountG < MIN_INGREDIENT_AMOUNT_G) return null;

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

// pool: the pre-fetched ingredient macro data for every name in
// INGREDIENT_POOL (built once per generation — see orchestrate.ts).
// varietySeed: e.g. dayIndex*2 + (mealType==='snack1' ? 0 : 1), so
// different slots in the same week pick different pool options.
export function composeSnack(
  target: MacroTargets,
  pool: Record<string, IngredientMacroLookup>,
  varietySeed: number,
): ComposedSnack {
  const ingredients: ComposedIngredient[] = [];
  let remainingCarbs = target.carbsG;
  let remainingFat = target.fatG;

  const proteinLookup = pool[pickFromPool("protein", varietySeed)];
  const proteinItem = proteinLookup
    ? sizeIngredientForGap(proteinLookup, proteinLookup.proteinGPer100g, target.proteinG)
    : null;
  if (proteinItem) {
    ingredients.push(proteinItem);
    remainingCarbs -= proteinItem.carbsG;
    remainingFat -= proteinItem.fatG;
  }

  const carbLookup = pool[pickFromPool("carb", varietySeed)];
  const carbItem = carbLookup ? sizeIngredientForGap(carbLookup, carbLookup.carbsGPer100g, remainingCarbs) : null;
  if (carbItem) {
    ingredients.push(carbItem);
    remainingFat -= carbItem.fatG;
  }

  const fatLookup = pool[pickFromPool("fat", varietySeed)];
  const fatItem = fatLookup ? sizeIngredientForGap(fatLookup, fatLookup.fatGPer100g, remainingFat) : null;
  if (fatItem) {
    ingredients.push(fatItem);
  }

  return {
    ingredients,
    totalCalories: ingredients.reduce((sum, i) => sum + i.caloriesKcal, 0),
    totalProteinG: ingredients.reduce((sum, i) => sum + i.proteinG, 0),
    totalCarbsG: ingredients.reduce((sum, i) => sum + i.carbsG, 0),
    totalFatG: ingredients.reduce((sum, i) => sum + i.fatG, 0),
  };
}

// Display title for the meal card — a composed snack has no single
// recipe title, so join the ingredient names (matches how a real person
// would describe it, e.g. "Greek Yogurt + Banana + Almonds").
export function composedSnackTitle(snack: ComposedSnack): string {
  return snack.ingredients.map((i) => titleCase(i.ingredientName)).join(" + ");
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
