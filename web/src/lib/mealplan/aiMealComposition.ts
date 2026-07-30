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
export const PORTION_BOUNDS_G: Record<MealRole, { min: number; max: number }> = {
  protein: { min: 20, max: 280 },
  carb: { min: 15, max: 250 },
  // max was 40 -- too tight for a less-concentrated fat source like
  // avocado (~15g fat/100g). Flagged as a speculative, unconfirmed
  // concern in the 2026-07-21 audit ("leave alone until actually
  // observed"); live-confirmed 2026-07-22 (stacked-safety
  // re-verification): avocado sized to 70g to close a modest ~10.5g fat
  // gap, rejected by the old 40g cap. Raised to 150g -- reuses the
  // `fixed` role's own already-established generous ceiling just below
  // (roughly "a whole avocado and then some," not an oil-bottle amount)
  // rather than inventing a new number. Barely matters for a concentrated
  // fat source (oil, butter): a realistic fat gap sized against ~100g
  // fat/100g density lands nowhere near this cap regardless, so widening
  // it only changes what's realistic for a source like avocado, not what
  // a genuinely oversized amount of oil would still catch.
  fat: { min: 3, max: 150 },
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

// Best-known realistic macro density (g per 100g) for the densest safe
// fallback source per role -- used only to sanity-check whether a role's
// ORIGINAL target is structurally reachable at all before orchestrate.ts's
// retry-with-feedback spends a retry attempt on a portion rejection for it
// (no real ingredient at any portion could have closed that gap, so
// re-asking with the same target would just repeat the same rejection).
// protein=73 is the one live-confirmed number here (pea protein powder,
// see mealProposer.ts's PROTEIN_EXAMPLES); carb=66 (rolled oats) and
// fat=100 (a pure oil, the practical ceiling for this role) are common
// real whole-food values, not independently live-verified the same way --
// good enough for a "was this even reachable" sanity check, not meant to
// be exact.
const BEST_KNOWN_DENSITY_PER_100G: Record<Exclude<MealRole, "fixed">, number> = {
  protein: 73,
  carb: 66,
  fat: 100,
};

export function bestKnownDensity(role: Exclude<MealRole, "fixed">): number {
  return BEST_KNOWN_DENSITY_PER_100G[role];
}

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

// Tagged reason for each way composeMealFromProposalDetailed can reject a
// proposal -- lets a caller (orchestrate.ts's retry-with-feedback) tell
// Claude concretely what to fix on its next attempt, instead of a bare
// null. describeRejectionForFeedback below turns one of these into a
// sentence for that prompt.
export type CompositionRejection =
  | { kind: "no_ingredients" }
  | { kind: "unsafe_ingredient"; role: MealRole; ingredientName: string; reason: string }
  | { kind: "duplicate_role"; role: MealRole }
  | { kind: "missing_role"; role: MealRole }
  | { kind: "fixed_item_unrealistic"; ingredientName: string; amountG: number; min: number; max: number }
  | { kind: "ingredient_not_found"; role: MealRole; ingredientName: string }
  | { kind: "portion_infeasible"; role: Exclude<MealRole, "fixed">; ingredientName: string; gapNeeded: number }
  | {
      kind: "portion_out_of_bounds";
      role: Exclude<MealRole, "fixed">;
      ingredientName: string;
      amountG: number;
      min: number;
      max: number;
      gapNeeded: number;
    };

export type ComposeMealResult = { ok: true; meal: ComposedMeal } | { ok: false; reason: CompositionRejection };

// Rejects (ok: false) on ANY failure -- malformed proposal, an unsafe
// ingredient, a lookup that doesn't resolve, or a solved amount outside its
// portion bound. Every failure mode falls through to the same "couldn't
// compose" result; the caller (orchestrate.ts) treats that exactly like
// today's existing blocked-slot state. Never partially composes, never
// forces an out-of-bounds amount through with a caveat -- fails closed on
// both safety and realism.
export async function composeMealFromProposalDetailed(
  proposal: MealProposal,
  target: MacroTargets,
  ctx: DietaryContext,
  fetchIngredientMacros: FetchIngredientMacrosFn,
): Promise<ComposeMealResult> {
  if (proposal.ingredients.length === 0) return { ok: false, reason: { kind: "no_ingredients" } };

  for (const ing of proposal.ingredients) {
    const unsafeReason = isOpenEndedIngredientUnsafeFor(ing.name, ctx);
    if (unsafeReason !== null) {
      return { ok: false, reason: { kind: "unsafe_ingredient", role: ing.role, ingredientName: ing.name, reason: unsafeReason } };
    }
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
    if (proposal.ingredients.filter((i) => i.role === role).length > 1) {
      return { ok: false, reason: { kind: "duplicate_role", role } };
    }
  }

  const proteinProposed = proposal.ingredients.find((i) => i.role === "protein");
  const carbProposed = proposal.ingredients.find((i) => i.role === "carb");
  const fatProposed = proposal.ingredients.find((i) => i.role === "fat");
  const fixedProposed = proposal.ingredients.filter((i) => i.role === "fixed");

  // A malformed proposal (missing a core role) isn't something to guess
  // around -- reject rather than compose an incomplete dish.
  if (!proteinProposed) return { ok: false, reason: { kind: "missing_role", role: "protein" } };
  if (!carbProposed) return { ok: false, reason: { kind: "missing_role", role: "carb" } };
  if (!fatProposed) return { ok: false, reason: { kind: "missing_role", role: "fat" } };

  const composed: ComposedMealIngredient[] = [];
  let remainingProtein = target.proteinG;
  let remainingCarbs = target.carbsG;
  let remainingFat = target.fatG;

  for (const fixedItem of fixedProposed) {
    const amountG = fixedItem.fixedAmountG ?? DEFAULT_FIXED_AMOUNT_G;
    if (!isRealisticAmount(amountG, PORTION_BOUNDS_G.fixed)) {
      return {
        ok: false,
        reason: {
          kind: "fixed_item_unrealistic",
          ingredientName: fixedItem.name,
          amountG,
          min: PORTION_BOUNDS_G.fixed.min,
          max: PORTION_BOUNDS_G.fixed.max,
        },
      };
    }
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
  if (!proteinLookup) {
    return { ok: false, reason: { kind: "ingredient_not_found", role: "protein", ingredientName: proteinProposed.name } };
  }
  const proteinSized = sizeForGap(proteinLookup.proteinGPer100g, remainingProtein);
  if (!proteinSized) {
    return {
      ok: false,
      reason: { kind: "portion_infeasible", role: "protein", ingredientName: proteinProposed.name, gapNeeded: remainingProtein },
    };
  }
  if (!isRealisticAmount(proteinSized.amountG, PORTION_BOUNDS_G.protein)) {
    return {
      ok: false,
      reason: {
        kind: "portion_out_of_bounds",
        role: "protein",
        ingredientName: proteinProposed.name,
        amountG: proteinSized.amountG,
        min: PORTION_BOUNDS_G.protein.min,
        max: PORTION_BOUNDS_G.protein.max,
        gapNeeded: remainingProtein,
      },
    };
  }
  const proteinItem = toComposedIngredient(proteinLookup, proteinSized.amountG);
  composed.push(proteinItem);
  remainingCarbs -= proteinItem.carbsG;
  remainingFat -= proteinItem.fatG;

  const carbLookup = await fetchIngredientMacros(carbProposed.name);
  if (!carbLookup) {
    return { ok: false, reason: { kind: "ingredient_not_found", role: "carb", ingredientName: carbProposed.name } };
  }
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
    if (!isRealisticAmount(carbSized.amountG, PORTION_BOUNDS_G.carb)) {
      return {
        ok: false,
        reason: {
          kind: "portion_out_of_bounds",
          role: "carb",
          ingredientName: carbProposed.name,
          amountG: carbSized.amountG,
          min: PORTION_BOUNDS_G.carb.min,
          max: PORTION_BOUNDS_G.carb.max,
          gapNeeded: remainingCarbs,
        },
      };
    }
    const carbItem = toComposedIngredient(carbLookup, carbSized.amountG);
    composed.push(carbItem);
    remainingFat -= carbItem.fatG;
  }

  const fatLookup = await fetchIngredientMacros(fatProposed.name);
  if (!fatLookup) {
    return { ok: false, reason: { kind: "ingredient_not_found", role: "fat", ingredientName: fatProposed.name } };
  }
  const fatSized = sizeForGap(fatLookup.fatGPer100g, remainingFat);
  // Unlike protein/carb, the fat role is allowed to contribute NOTHING --
  // remainingFat can already be <=0 once protein/carb's own fat is
  // counted (same as composeSnack's existing behavior). Only an
  // out-of-bounds amount rejects the whole dish; an absent one doesn't.
  if (fatSized) {
    if (!isRealisticAmount(fatSized.amountG, PORTION_BOUNDS_G.fat)) {
      return {
        ok: false,
        reason: {
          kind: "portion_out_of_bounds",
          role: "fat",
          ingredientName: fatProposed.name,
          amountG: fatSized.amountG,
          min: PORTION_BOUNDS_G.fat.min,
          max: PORTION_BOUNDS_G.fat.max,
          gapNeeded: remainingFat,
        },
      };
    }
    composed.push(toComposedIngredient(fatLookup, fatSized.amountG));
  }

  const anyCostUnknown = composed.some((i) => i.estimatedCostCents === null);
  return {
    ok: true,
    meal: {
      dishName: proposal.dishName,
      ingredients: composed,
      totalCalories: composed.reduce((s, i) => s + i.caloriesKcal, 0),
      totalProteinG: composed.reduce((s, i) => s + i.proteinG, 0),
      totalCarbsG: composed.reduce((s, i) => s + i.carbsG, 0),
      totalFatG: composed.reduce((s, i) => s + i.fatG, 0),
      totalEstimatedCostCents: !anyCostUnknown ? composed.reduce((s, i) => s + (i.estimatedCostCents ?? 0), 0) : null,
    },
  };
}

// Thin wrapper kept for existing callers/tests that only care whether
// composition succeeded, not why it didn't.
export async function composeMealFromProposal(
  proposal: MealProposal,
  target: MacroTargets,
  ctx: DietaryContext,
  fetchIngredientMacros: FetchIngredientMacrosFn,
): Promise<ComposedMeal | null> {
  const result = await composeMealFromProposalDetailed(proposal, target, ctx, fetchIngredientMacros);
  return result.ok ? result.meal : null;
}

// One plain-English sentence per rejection kind, meant to be fed straight
// back to Claude as "here's why your last attempt for this slot was
// rejected" -- generic and specific enough to act on without knowing the
// real rejection-kind breakdown ahead of time (that breakdown is exactly
// what Step D's live counters exist to measure).
export function describeRejectionForFeedback(reason: CompositionRejection): string {
  switch (reason.kind) {
    case "no_ingredients":
      return "Your proposal had no ingredients at all. List one protein, one carb, and one fat ingredient (plus optional fixed garnishes/sides).";
    case "unsafe_ingredient":
      return `"${reason.ingredientName}" (${reason.role}) isn't safe for this person: ${reason.reason}. Pick a different ${reason.role} ingredient that fits their diet, allergies, and dislikes.`;
    case "duplicate_role":
      return `You listed more than one ingredient for the "${reason.role}" role. Pick exactly one ingredient per core role.`;
    case "missing_role":
      return `Your proposal is missing a "${reason.role}" ingredient. Every dish needs exactly one protein, one carb, and one fat ingredient.`;
    case "fixed_item_unrealistic":
      return `The fixed item "${reason.ingredientName}" at ${Math.round(reason.amountG)}g isn't a realistic garnish/side amount (needs to be ${reason.min}-${reason.max}g). Give it a normal serving size or drop it.`;
    case "ingredient_not_found":
      return `"${reason.ingredientName}" (${reason.role}) couldn't be matched to a real ingredient. Use a more common, specific grocery-store name for the ${reason.role} ingredient.`;
    case "portion_infeasible":
      return `"${reason.ingredientName}" (${reason.role}) can't realistically close the remaining ~${Math.round(reason.gapNeeded)}g gap for this role. Pick a more macro-dense ${reason.role} source.`;
    case "portion_out_of_bounds": {
      const over = reason.amountG > reason.max;
      const bound = over ? reason.max : reason.min;
      return `Your ${reason.role} choice, "${reason.ingredientName}", needed ${Math.round(reason.amountG)}g -- ${
        over ? "over" : "under"
      } the realistic ${bound}g ${over ? "cap" : "floor"}. Pick a ${over ? "denser" : "less concentrated"} ${reason.role} source.`;
    }
  }
}
