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
  estimatedCostCentsPer100g: number | null;
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
  estimatedCostCents: number | null;
}

export interface ComposedMeal {
  dishName: string;
  ingredients: ComposedMealIngredient[];
  totalCalories: number;
  totalProteinG: number;
  totalCarbsG: number;
  totalFatG: number;
  // null if ANY ingredient's cost is unknown -- same "don't guess" rule
  // as snackComposition.ts's totalEstimatedCostCents.
  totalEstimatedCostCents: number | null;
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
  // min was 5 -- too strict for the "a spice" case explicitly named in
  // this role's own prompt description ("a vegetable side, a garnish, a
  // spice"). Live-confirmed 2026-07-21: Claude proposed "smoked paprika"
  // at a genuinely realistic fixedAmountG=2 (a normal seasoning amount),
  // which rejected the WHOLE composition for being "too small" -- the
  // opposite of the realism problem this bound exists to catch. A
  // vegetable-side-scale garnish (40g+) and a spice-scale one (1-3g) are
  // both legitimately "fixed," so the floor needs to accommodate the
  // smaller end of that range, not just the larger one. max unchanged --
  // still catches a genuinely oversized garnish.
  fixed: { min: 1, max: 150 },
};

// Found live 2026-07-21 (thin-corpus AI-compose investigation): fixedAmountG
// is optional in both the tool schema and the prompt's own wording ("fixed
// ones don't need to hit any macro, just be a normal small serving") -- the
// prompt never tells Claude a gram amount is mandatory, so garnish/side
// items (parsley, a lemon wedge, cherry tomatoes) routinely arrive with no
// fixedAmountG at all. That defaulted to 0 below, which fails
// isRealisticAmount (min 5) and silently rejected the WHOLE composition --
// live-confirmed to reproduce with an otherwise-perfect macro fit (every
// other role landing within a few percent of target) purely because one
// garnish had no amount. A normal small side/garnish serving, not a hard
// macro solve, so a fixed realistic default is the right fallback here
// (matches the doc comment's own "e.g. 40 for a side of spinach" example)
// rather than making the prompt/schema demand a number from the LLM for
// something it explicitly doesn't need to size precisely.
const DEFAULT_FIXED_AMOUNT_G = 40;

// Number.isFinite, not just min/max comparisons -- found July 16 2026
// (comprehensive engine test): `amountG < min || amountG > max` is FALSE
// for NaN (every NaN comparison is false), so a NaN amount used to
// silently pass this realism check where Infinity was already correctly
// caught. Not reachable via a real Claude response today (JSON can't
// emit a literal NaN token), but this is the function's own stated
// guarantee ("fails closed on both safety and realism"), so it should
// hold regardless of caller.
function isRealisticAmount(amountG: number, bounds: { min: number; max: number }): boolean {
  return Number.isFinite(amountG) && amountG >= bounds.min && amountG <= bounds.max;
}

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
    estimatedCostCents: lookup.estimatedCostCentsPer100g !== null ? lookup.estimatedCostCentsPer100g * scale : null,
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

  // A proposal listing more than one ingredient for the same core role
  // used to silently lose every ingredient after the first -- `.find()`
  // below only ever returns one match, so the second protein/carb/fat
  // item was never fetched, sized, or counted anywhere, with no error
  // signal (found July 16 2026, comprehensive engine test: confirmed live
  // with a two-protein-role proposal that silently dropped the second
  // ingredient and undercounted the meal's real macros). Same "malformed
  // proposal, reject rather than guess" discipline as the missing-role
  // check below -- a duplicate role is exactly as malformed as a missing
  // one, just in the other direction.
  for (const role of ["protein", "carb", "fat"] as const) {
    if (proposal.ingredients.filter((i) => i.role === role).length > 1) return null;
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
    const amountG = fixedItem.fixedAmountG ?? DEFAULT_FIXED_AMOUNT_G;
    if (!isRealisticAmount(amountG, PORTION_BOUNDS_G.fixed)) return null;
    // Found live 2026-07-21 (same investigation as DEFAULT_FIXED_AMOUNT_G
    // above): a fixed item's name sometimes doesn't resolve via Spoonacular's
    // ingredient search at all -- e.g. "steamed broccoli florets" or "steamed
    // baby carrots" returned no match, while the same vegetable without the
    // prep-word prefix likely would. A failed lookup used to reject the WHOLE
    // composition here, same class of bug as the missing-amount case: fixed
    // items are explicitly non-critical for macro accuracy ("don't need to
    // hit any macro, just be a normal small serving"), so a garnish that
    // can't be looked up should just be dropped from the dish, not sink an
    // otherwise-good protein/carb/fat solve. Unlike protein/carb/fat lookup
    // failures (still a hard reject below) -- those roles are load-bearing
    // for the actual macro target, a fixed item never is.
    const lookup = await fetchIngredientMacros(fixedItem.name);
    if (!lookup) continue;
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
  if (!isRealisticAmount(proteinSized.amountG, PORTION_BOUNDS_G.protein)) return null;
  const proteinItem = toComposedIngredient(proteinLookup, proteinSized.amountG);
  composed.push(proteinItem);
  remainingCarbs -= proteinItem.carbsG;
  remainingFat -= proteinItem.fatG;

  const carbLookup = await fetchIngredientMacros(carbProposed.name);
  if (!carbLookup) return null;
  const carbSized = sizeForGap(carbLookup.carbsGPer100g, remainingCarbs);
  // Live-confirmed (2026-07-21, stacked-safety investigation): a carb-heavy
  // protein source (lentils, chickpeas, black beans -- common go-tos once
  // dairy/soy/nuts/eggs are all excluded) can already cover the carb
  // target on its own, leaving remainingCarbs <=0 by the time this role is
  // reached -- sizeForGap correctly returns null for a non-positive gap,
  // but this used to hard-reject the WHOLE dish for it, even though
  // "nothing left to add" is a perfectly fine outcome, not a failure. Now
  // treated the same as the fat role's existing "allowed to contribute
  // NOTHING" exception just below -- only an out-of-bounds amount rejects
  // the dish; an absent one (for any reason sizeForGap returns null)
  // doesn't.
  if (carbSized) {
    if (!isRealisticAmount(carbSized.amountG, PORTION_BOUNDS_G.carb)) return null;
    const carbItem = toComposedIngredient(carbLookup, carbSized.amountG);
    composed.push(carbItem);
    remainingFat -= carbItem.fatG;
  }

  const fatLookup = await fetchIngredientMacros(fatProposed.name);
  if (!fatLookup) return null;
  const fatSized = sizeForGap(fatLookup.fatGPer100g, remainingFat);
  // Unlike protein/carb, the fat role is allowed to contribute NOTHING --
  // remainingFat can already be <=0 once protein/carb's own fat is
  // counted (same as composeSnack's existing behavior). Only an
  // out-of-bounds amount rejects the whole dish; an absent one doesn't.
  if (fatSized) {
    if (!isRealisticAmount(fatSized.amountG, PORTION_BOUNDS_G.fat)) return null;
    composed.push(toComposedIngredient(fatLookup, fatSized.amountG));
  }

  const anyCostUnknown = composed.some((i) => i.estimatedCostCents === null);
  return {
    dishName: proposal.dishName,
    ingredients: composed,
    totalCalories: composed.reduce((s, i) => s + i.caloriesKcal, 0),
    totalProteinG: composed.reduce((s, i) => s + i.proteinG, 0),
    totalCarbsG: composed.reduce((s, i) => s + i.carbsG, 0),
    totalFatG: composed.reduce((s, i) => s + i.fatG, 0),
    totalEstimatedCostCents: !anyCostUnknown ? composed.reduce((s, i) => s + (i.estimatedCostCents ?? 0), 0) : null,
  };
}
