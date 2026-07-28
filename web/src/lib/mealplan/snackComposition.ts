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
import { rankByPantryAndPrice, type PantryPriceContext } from "./pantryPricePreference";
import { MAX_REALISTIC_AMOUNT_G, DEFAULT_MAX_REALISTIC_AMOUNT_G } from "./staticIngredientMacros";

export type MacroRole = "protein" | "carb" | "fat";

export interface IngredientMacroLookup {
  id: number;
  name: string;
  caloriesPer100g: number;
  proteinGPer100g: number;
  carbsGPer100g: number;
  fatGPer100g: number;
  estimatedCostCentsPer100g: number | null;
}

// Small, fixed pool per role — real-food, not exotic, matching what
// Prospre's own snack examples actually look like (protein shake/yogurt,
// banana/orange, occasionally nuts). 3 options per role gives real
// rotation across a week's 14 snack slots without an unbounded lookup
// cost — all ingredients are fetched once per generation, not per slot.
//
// protein/fat each widened from 3 to 5 (audit round 2, July 15 2026): the
// original 3 protein options are all dairy- or soy-tagged and the
// original 3 fat options are all nut-tagged, so a vegan + nut allergy +
// soy allergy profile had ZERO safe options in either role (collapsed a
// plan to 17% of target, see engine-audit-2026-07-15-round2.md finding
// 4). Added 2 per starved role, not 1 -- a single addition leaves exactly
// 1 safe option for this profile, the same "collapses to 1, no rotation"
// failure already found and fixed for pantry/budget preference.
export const INGREDIENT_POOL: Record<MacroRole, string[]> = {
  protein: ["greek yogurt", "cottage cheese", "protein powder", "pea protein powder", "hemp seeds"],
  carb: ["banana", "apple", "orange"],
  fat: ["almonds", "peanut butter", "walnuts", "sunflower seed butter", "chia seeds"],
};

export function allPoolIngredientNames(): string[] {
  return [...INGREDIENT_POOL.protein, ...INGREDIENT_POOL.carb, ...INGREDIENT_POOL.fat];
}

// Deterministic rotation (day index x slot position, not Math.random —
// this is a real backend generation path, same determinism requirement as
// everything else in mealplan/) so a week's 14 snack slots don't all use
// the identical 3 ingredients.
//
// Picks among whichever of this role's options are actually present as
// keys in `pool` — the caller (orchestrate.ts's fetchSnackIngredientPool)
// pre-filters unsafe ingredients out of `pool` entirely for this profile
// (see ingredientSafety.ts), so this rotates among the remaining SAFE
// options rather than blindly indexing the full fixed 3 and silently
// losing this role's contribution whenever the seed happens to land on an
// option that was filtered out. Returns null only when every option for
// this role is unsafe for this profile (e.g. every fat-role ingredient
// contains nuts for a nut allergy) — that role's contribution is then
// genuinely skipped, same graceful degradation as an unresolvable lookup.
//
// Pantry/price preference (retrofitted July 15 2026): among the SAFE
// available options, a pantry match (or, failing that, the cheapest
// known-cost option when budget-aware) is preferred — but the variety
// seed still rotates, just scoped to WHICHEVER tier is preferred
// (pantryPricePreference.ts's preferredCount), not the full list. Without
// that scoping, reordering alone would only shuffle which seed index
// happens to land on the preferred option, not actually favor it.
function pickFromPool(
  role: MacroRole,
  varietySeed: number,
  pool: Record<string, IngredientMacroLookup>,
  ctx: PantryPriceContext,
): string | null {
  const available = INGREDIENT_POOL[role]
    .filter((name) => pool[name] !== undefined)
    .map((name) => ({ name, costCentsPer100g: pool[name].estimatedCostCentsPer100g }));
  if (available.length === 0) return null;
  const { ordered, preferredCount } = rankByPantryAndPrice(available, ctx);
  return ordered[varietySeed % preferredCount].name;
}

export interface ComposedIngredient {
  ingredientName: string;
  spoonacularIngredientId: number;
  amountG: number;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  // Real cost for this sized amount, or null if Spoonacular had no cost
  // data for this ingredient — never estimated/fabricated.
  estimatedCostCents: number | null;
}

export interface ComposedSnack {
  ingredients: ComposedIngredient[];
  totalCalories: number;
  totalProteinG: number;
  totalCarbsG: number;
  totalFatG: number;
  // null if ANY ingredient's cost is unknown -- a partial sum would
  // understate the real price and could mislead a budget-conscious user,
  // so an incomplete total is treated as no total, same "don't guess"
  // rule as everything else that touches Spoonacular's real data here.
  totalEstimatedCostCents: number | null;
}

const MIN_INGREDIENT_AMOUNT_G = 10;

// Per-ingredient realistic-portion ceiling (MAX_REALISTIC_AMOUNT_G /
// DEFAULT_MAX_REALISTIC_AMOUNT_G) now lives in staticIngredientMacros.ts,
// shared with addon.ts -- see that file for the full rationale (audit item
// #3, 2026-07-21 spec originally; moved here 2026-07-28).

// Sizes one ingredient to close a specific macro gap (protein/carbs/fat),
// rounding down to the nearest 5g and skipping it entirely if that rounds
// below a sensible minimum or above a realistic serving — same pattern as
// addon.ts's buildAddonForSlot.
function sizeIngredientForGap(
  lookup: IngredientMacroLookup,
  macroPer100g: number,
  gapNeeded: number,
): ComposedIngredient | null {
  if (macroPer100g <= 0 || gapNeeded <= 0) return null;
  const amountG = Math.floor(((gapNeeded / macroPer100g) * 100) / 5) * 5;
  if (amountG < MIN_INGREDIENT_AMOUNT_G) return null;
  const maxAmountG = MAX_REALISTIC_AMOUNT_G[lookup.name] ?? DEFAULT_MAX_REALISTIC_AMOUNT_G;
  if (amountG > maxAmountG) return null;

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

// pool: the pre-fetched ingredient macro data for every name in
// INGREDIENT_POOL (built once per generation — see orchestrate.ts).
// varietySeed: e.g. dayIndex*2 + (mealType==='snack1' ? 0 : 1), so
// different slots in the same week pick different pool options.
export function composeSnack(
  target: MacroTargets,
  pool: Record<string, IngredientMacroLookup>,
  varietySeed: number,
  ctx: PantryPriceContext = { pantryItemNames: [], budgetAware: false },
): ComposedSnack {
  const ingredients: ComposedIngredient[] = [];
  let remainingCarbs = target.carbsG;
  let remainingFat = target.fatG;

  const proteinName = pickFromPool("protein", varietySeed, pool, ctx);
  const proteinLookup = proteinName ? pool[proteinName] : undefined;
  const proteinItem = proteinLookup
    ? sizeIngredientForGap(proteinLookup, proteinLookup.proteinGPer100g, target.proteinG)
    : null;
  if (proteinItem) {
    ingredients.push(proteinItem);
    remainingCarbs -= proteinItem.carbsG;
    remainingFat -= proteinItem.fatG;
  }

  const carbName = pickFromPool("carb", varietySeed, pool, ctx);
  const carbLookup = carbName ? pool[carbName] : undefined;
  const carbItem = carbLookup ? sizeIngredientForGap(carbLookup, carbLookup.carbsGPer100g, remainingCarbs) : null;
  if (carbItem) {
    ingredients.push(carbItem);
    remainingFat -= carbItem.fatG;
  }

  const fatName = pickFromPool("fat", varietySeed, pool, ctx);
  const fatLookup = fatName ? pool[fatName] : undefined;
  const fatItem = fatLookup ? sizeIngredientForGap(fatLookup, fatLookup.fatGPer100g, remainingFat) : null;
  if (fatItem) {
    ingredients.push(fatItem);
  }

  const anyCostUnknown = ingredients.some((i) => i.estimatedCostCents === null);
  return {
    ingredients,
    totalCalories: ingredients.reduce((sum, i) => sum + i.caloriesKcal, 0),
    totalProteinG: ingredients.reduce((sum, i) => sum + i.proteinG, 0),
    totalCarbsG: ingredients.reduce((sum, i) => sum + i.carbsG, 0),
    totalFatG: ingredients.reduce((sum, i) => sum + i.fatG, 0),
    totalEstimatedCostCents:
      ingredients.length > 0 && !anyCostUnknown
        ? ingredients.reduce((sum, i) => sum + (i.estimatedCostCents ?? 0), 0)
        : null,
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
