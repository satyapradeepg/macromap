// AI composition fallback (F3, deferred since the July 14 2026 pivot,
// built July 15 2026 after a live extreme-profile test showed several
// blocked breakfast/lunch slots have no Spoonacular recipe match at all --
// not fixable by more query engineering, a genuine judgment gap).
//
// Grounding rule (same as addon.ts/snackComposition.ts, docs/PRD-MacroMap.md
// 7.3 F3): the LLM decides WHAT ingredients belong in a dish -- a
// judgment/creative task -- and NEVER supplies a macro number itself.
// Every calorie/protein/carb/fat shown is resolved from Spoonacular's real
// ingredient data and summed here, deterministically.
//
// Two independent guardrails sit between the LLM's proposal and what a
// user ever sees, and BOTH must pass or the whole composition is rejected
// (falls through to the existing blocked-slot state -- never partially
// applied, never forced):
// 1. openEndedIngredientSafety.ts -- allergy/diet/dislike safety, fail
//    closed for anything ambiguous.
// 2. PORTION_BOUNDS_G below -- realism. Found live: naively sizing a
//    single ingredient to close a macro gap can demand an unrealistic
//    amount (346g of tofu to hit 31g protein alone, which ALSO already
//    overshoot the fat target before anything else was added) even when
//    every ingredient is otherwise perfectly safe and well-chosen. A
//    portion bound catches this regardless of how good the LLM's
//    ingredient choice was -- it's not a substitute for asking the LLM to
//    pick a macro-dense-enough ingredient (that's still the main lever --
//    seitan instead of tofu fixed the same target at a normal 140g), it's
//    the deterministic backstop for when that reasoning still misses.

import type { MacroTargets } from "./targets";
import { isOpenEndedIngredientUnsafeFor, type DietaryContext } from "./openEndedIngredientSafety";

export type MealRole = "protein" | "carb" | "fat" | "fixed";

export interface ProposedIngredient {
  name: string;
  role: MealRole;
  // Only meaningful for role="fixed" (a small garnish/aromatic that isn't
  // macro-solved, e.g. "40g spinach") -- protein/carb/fat roles are always
  // sized by this module, never by the proposer.
  fixedAmountG?: number;
}

export interface MealProposal {
  dishName: string;
  ingredients: ProposedIngredient[];
}

export interface GroundedIngredientData {
  id: number;
  name: string;
  caloriesPer100g: number;
  proteinGPer100g: number;
  carbsGPer100g: number;
  fatGPer100g: number;
}

export type FetchIngredientMacrosFn = (query: string) => Promise<GroundedIngredientData | null>;

export interface ComposedMealIngredient {
  ingredientName: string;
  spoonacularIngredientId: number;
  amountG: number;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface ComposedMeal {
  dishName: string;
  ingredients: ComposedMealIngredient[];
  totalCalories: number;
  totalProteinG: number;
  totalCarbsG: number;
  totalFatG: number;
}

const MIN_INGREDIENT_AMOUNT_G = 10;

// Realistic per-serving gram bounds by role. A solved amount outside its
// role's bound rejects the WHOLE composition (not just that ingredient --
// there's no sensible partial result once one role's math has gone
// unrealistic). Deliberately generous, not tight -- these exist to catch
// genuine outliers (300g+ of a lean protein, a stick of butter's worth of
// oil), not to second-guess ordinary recipe variation.
const PORTION_BOUNDS_G: Record<MealRole, { min: number; max: number }> = {
  protein: { min: 20, max: 280 },
  carb: { min: 15, max: 250 },
  fat: { min: 3, max: 40 },
  fixed: { min: 5, max: 150 },
};

function sizeForGap(
  macroPer100g: number,
  gapNeeded: number,
): { amountG: number } | null {
  if (macroPer100g <= 0 || gapNeeded <= 0) return null;
  const amountG = Math.floor(((gapNeeded / macroPer100g) * 100) / 5) * 5;
  if (amountG < MIN_INGREDIENT_AMOUNT_G) return null;
  return { amountG };
}

function toComposedIngredient(lookup: GroundedIngredientData, amountG: number): ComposedMealIngredient {
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

// Returns null on ANY failure -- malformed proposal, an unsafe ingredient,
// a lookup that doesn't resolve, or a solved amount outside its portion
// bound. Every failure mode falls through to the same "couldn't compose"
// result; the caller (orchestrate.ts) treats that exactly like today's
// existing blocked-slot state. Never partially composes, never forces an
// out-of-bounds amount through with a caveat -- fails closed on both
// safety and realism.
export async function composeMealFromProposal(
  proposal: MealProposal,
  target: MacroTargets,
  ctx: DietaryContext,
  fetchIngredientMacros: FetchIngredientMacrosFn,
): Promise<ComposedMeal | null> {
  if (proposal.ingredients.length === 0) return null;

  for (const ing of proposal.ingredients) {
    if (isOpenEndedIngredientUnsafeFor(ing.name, ctx) !== null) return null;
  }

  const proteinProposed = proposal.ingredients.find((i) => i.role === "protein");
  const carbProposed = proposal.ingredients.find((i) => i.role === "carb");
  const fatProposed = proposal.ingredients.find((i) => i.role === "fat");
  const fixedProposed = proposal.ingredients.filter((i) => i.role === "fixed");

  // A malformed proposal (missing a core role) isn't something to guess
  // around -- reject rather than compose an incomplete dish.
  if (!proteinProposed || !carbProposed || !fatProposed) return null;

  const composed: ComposedMealIngredient[] = [];
  let remainingProtein = target.proteinG;
  let remainingCarbs = target.carbsG;
  let remainingFat = target.fatG;

  for (const fixedItem of fixedProposed) {
    const amountG = fixedItem.fixedAmountG ?? 0;
    if (amountG < PORTION_BOUNDS_G.fixed.min || amountG > PORTION_BOUNDS_G.fixed.max) return null;
    const lookup = await fetchIngredientMacros(fixedItem.name);
    if (!lookup) return null;
    const item = toComposedIngredient(lookup, amountG);
    composed.push(item);
    remainingProtein -= item.proteinG;
    remainingCarbs -= item.carbsG;
    remainingFat -= item.fatG;
  }

  // Known, accepted limitation (same shape as composeSnack's): protein is
  // sized here against the FULL remaining target without knowing the
  // carb/fat roles' own protein content yet (e.g. bread genuinely has
  // ~12g protein/100g) -- so real total protein can land meaningfully
  // over target even though this role's own sizing is correct. Carbs/fat
  // ARE corrected for cross-contributions in the other direction (each
  // later role subtracts what earlier roles already contributed). Live
  // example (July 15 2026): seitan sized for a 30.8g protein target, real
  // total came out to 38.5g (+25%) once bread's own protein was counted --
  // an overshoot, not a shortfall, and still a real improvement over
  // rejecting the slot outright.
  const proteinLookup = await fetchIngredientMacros(proteinProposed.name);
  if (!proteinLookup) return null;
  const proteinSized = sizeForGap(proteinLookup.proteinGPer100g, remainingProtein);
  if (!proteinSized) return null;
  if (proteinSized.amountG < PORTION_BOUNDS_G.protein.min || proteinSized.amountG > PORTION_BOUNDS_G.protein.max) return null;
  const proteinItem = toComposedIngredient(proteinLookup, proteinSized.amountG);
  composed.push(proteinItem);
  remainingCarbs -= proteinItem.carbsG;
  remainingFat -= proteinItem.fatG;

  const carbLookup = await fetchIngredientMacros(carbProposed.name);
  if (!carbLookup) return null;
  const carbSized = sizeForGap(carbLookup.carbsGPer100g, remainingCarbs);
  if (!carbSized) return null;
  if (carbSized.amountG < PORTION_BOUNDS_G.carb.min || carbSized.amountG > PORTION_BOUNDS_G.carb.max) return null;
  const carbItem = toComposedIngredient(carbLookup, carbSized.amountG);
  composed.push(carbItem);
  remainingFat -= carbItem.fatG;

  const fatLookup = await fetchIngredientMacros(fatProposed.name);
  if (!fatLookup) return null;
  const fatSized = sizeForGap(fatLookup.fatGPer100g, remainingFat);
  // Unlike protein/carb, the fat role is allowed to contribute NOTHING --
  // remainingFat can already be <=0 once protein/carb's own fat is
  // counted (same as composeSnack's existing behavior). Only an
  // out-of-bounds amount rejects the whole dish; an absent one doesn't.
  if (fatSized) {
    if (fatSized.amountG < PORTION_BOUNDS_G.fat.min || fatSized.amountG > PORTION_BOUNDS_G.fat.max) return null;
    composed.push(toComposedIngredient(fatLookup, fatSized.amountG));
  }

  return {
    dishName: proposal.dishName,
    ingredients: composed,
    totalCalories: composed.reduce((s, i) => s + i.caloriesKcal, 0),
    totalProteinG: composed.reduce((s, i) => s + i.proteinG, 0),
    totalCarbsG: composed.reduce((s, i) => s + i.carbsG, 0),
    totalFatG: composed.reduce((s, i) => s + i.fatG, 0),
  };
}
