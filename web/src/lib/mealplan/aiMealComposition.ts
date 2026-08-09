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
  // Additive (F11 chat-driven meal editing, 2026-08-09): recorded on newly
  // composed ingredients going forward so a future edit doesn't need to
  // re-infer role for a slot generated after this change -- optional
  // because it was never persisted before this, so an OLD slot's
  // ingredients genuinely may not have it. Nothing in composeMealFromEditDetailed
  // below actually depends on this being present; the edit proposer is
  // always shown the CURRENT ingredient list as plain description text
  // (no roles needed) and always returns a fresh, complete, role-tagged
  // list itself.
  role?: MealRole;
}

// F11 chat-driven meal editing (2026-08-09): the edit-proposal LLM call
// always returns the COMPLETE new ingredient list (not a diff), with an
// explicit gram amount for every ingredient, changed or not -- see
// mealEditProposer.ts. This is the key difference from MealProposal/
// ProposedIngredient above: an edit never solves an amount against a
// macro target (composeMealFromProposalDetailed's whole job), it just
// grounds an already-fully-specified list.
export interface EditedIngredient {
  name: string;
  role: MealRole;
  amountG: number;
}

export interface MealEditProposal {
  dishName: string;
  ingredients: EditedIngredient[];
  // One short, user-facing sentence describing what changed -- unlike
  // mealProposer.ts's titleIngredientCheck/constraintCheck self-check
  // fields (purely additive, never read), this one IS read and surfaced
  // directly as the assistant's chat reply on success. Safe to trust for
  // DISPLAY only: the real accept/reject verdict and every macro number
  // still come entirely from composeMealFromEditDetailed's deterministic
  // grounding below, never from this sentence.
  changeSummary: string;
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

const MAX_REFINEMENT_ROUNDS = 5;
// A refined amount changing by less than this between rounds is treated as
// converged -- half of sizeForGap's own 5g rounding granularity, so tighter
// precision wouldn't survive that rounding anyway.
const REFINEMENT_CONVERGENCE_EPSILON_G = 2.5;

interface RoleAmounts {
  proteinAmountG: number;
  carbAmountG: number | null;
  fatAmountG: number | null;
}

// Corrects the directional protein-overshoot limitation documented at
// composeMealFromProposalDetailed's protein-sizing step below: that step
// (and this function's own starting point) sizes protein against the FULL
// remaining target before the carb/fat ingredients' own protein content is
// known, then never revisits it -- a real logged case sized seitan for
// 30.8g protein and landed at 38.5g actual (+25%) once bread's ~12g
// protein/100g was counted (see this file's test suite). Each round here
// re-solves all three roles against the OTHER TWO roles' actual (latest)
// cross-contribution, which is exactly the missing information --
// hand-verified against that same regression case: one round alone takes
// protein from 38.5g to 30.75g actual, and a second round reproduces the
// first exactly, confirming a stable fixed point rather than oscillation.
//
// Deliberately conservative about when to accept a refined round: if it
// would push protein's own gap non-positive (nothing realistic left to
// solve for a MANDATORY role) or push any role's amount outside its own
// PORTION_BOUNDS_G, refinement stops immediately and returns the LAST
// accepted amounts rather than that round's -- this can only ever match or
// improve on the starting amounts, never introduce a rejection or an
// unrealistic portion the starting sequential solve wouldn't already have
// produced on its own.
function refineRoleAmounts(
  proteinLookup: GroundedIngredientData,
  carbLookup: GroundedIngredientData,
  fatLookup: GroundedIngredientData,
  fixedAdjustedTarget: { proteinG: number; carbsG: number; fatG: number },
  starting: RoleAmounts,
): RoleAmounts {
  let current = starting;

  for (let round = 0; round < MAX_REFINEMENT_ROUNDS; round++) {
    const carbAmt = current.carbAmountG ?? 0;
    const fatAmt = current.fatAmountG ?? 0;

    const proteinGap =
      fixedAdjustedTarget.proteinG -
      (carbLookup.proteinGPer100g / 100) * carbAmt -
      (fatLookup.proteinGPer100g / 100) * fatAmt;
    const proteinSized = sizeForGap(proteinLookup.proteinGPer100g, proteinGap);
    if (!proteinSized || !isRealisticAmount(proteinSized.amountG, PORTION_BOUNDS_G.protein)) {
      return current;
    }

    const carbGap =
      fixedAdjustedTarget.carbsG -
      (proteinLookup.carbsGPer100g / 100) * proteinSized.amountG -
      (fatLookup.carbsGPer100g / 100) * fatAmt;
    const carbSized = sizeForGap(carbLookup.carbsGPer100g, carbGap);
    if (carbSized && !isRealisticAmount(carbSized.amountG, PORTION_BOUNDS_G.carb)) {
      return current;
    }

    const fatGap =
      fixedAdjustedTarget.fatG -
      (proteinLookup.fatGPer100g / 100) * proteinSized.amountG -
      (carbLookup.fatGPer100g / 100) * (carbSized?.amountG ?? 0);
    const fatSized = sizeForGap(fatLookup.fatGPer100g, fatGap, PORTION_BOUNDS_G.fat.min);
    if (fatSized && !isRealisticAmount(fatSized.amountG, PORTION_BOUNDS_G.fat)) {
      return current;
    }

    const next: RoleAmounts = {
      proteinAmountG: proteinSized.amountG,
      carbAmountG: carbSized?.amountG ?? null,
      fatAmountG: fatSized?.amountG ?? null,
    };

    const converged =
      Math.abs(next.proteinAmountG - current.proteinAmountG) < REFINEMENT_CONVERGENCE_EPSILON_G &&
      Math.abs((next.carbAmountG ?? 0) - (current.carbAmountG ?? 0)) < REFINEMENT_CONVERGENCE_EPSILON_G &&
      Math.abs((next.fatAmountG ?? 0) - (current.fatAmountG ?? 0)) < REFINEMENT_CONVERGENCE_EPSILON_G;

    current = next;
    if (converged) break;
  }

  return current;
}

// minAmountG defaults to the universal MIN_INGREDIENT_AMOUNT_G floor, so
// every existing caller (protein/carb, whose own PORTION_BOUNDS_G.min --
// 20/15 -- already sits above it) is completely unaffected. Fat's own
// PORTION_BOUNDS_G.min (3g) is BELOW this universal floor, though -- found
// live 2026-08-01 auditing fat under-delivery: a fat gap of, say, 5-9g
// (5g of olive oil is a completely normal amount) was silently dropped
// entirely by this function's own 10g gate, before the caller's
// isRealisticAmount(amountG, PORTION_BOUNDS_G.fat) check ever got a chance
// to see it and correctly accept it -- PORTION_BOUNDS_G.fat.min=3 has been
// unreachable dead code for the fat role specifically since it was set.
// Passing PORTION_BOUNDS_G.fat.min explicitly at the fat-role call sites
// lets a real, non-negligible small fat amount through instead.
function sizeForGap(
  macroPer100g: number,
  gapNeeded: number,
  minAmountG: number = MIN_INGREDIENT_AMOUNT_G,
): { amountG: number } | null {
  if (macroPer100g <= 0 || gapNeeded <= 0) return null;
  const amountG = Math.floor(((gapNeeded / macroPer100g) * 100) / 5) * 5;
  if (amountG < minAmountG) return null;
  return { amountG };
}

// Used only by composeMealFromProposalBestEffort's relaxedRoleItem below --
// how far over a role's realistic portion ceiling a sized amount can be
// before it's treated as "this ingredient's density is the wrong shape
// for this role" rather than "a reasonable amount that's merely a bit
// oversized." 1.5x is comfortably above the existing tofu-protein
// regression test's 1.24x (346g needed / 280g cap, correctly still a
// clamp) and comfortably below both real cheese-as-carb cases found live
// (1.64x and 1.86x), so it separates the two without disturbing the
// already-established near-miss behavior.
const IMPLAUSIBLE_OVERAGE_MULTIPLIER = 1.5;

function toComposedIngredient(lookup: GroundedIngredientData, amountG: number, role?: MealRole): ComposedMealIngredient {
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
    role,
  };
}

// Exact inverse of toComposedIngredient's linear scaling -- reconstructs an
// already-composed item's per-100g density without a second fetch. Used by
// composeMealFromProposalBestEffort's refinement pass (below) to reuse
// round 0's already-fetched ingredient data for the same purpose
// refineRoleAmounts already serves the strict composer.
function reverseTo100g(item: ComposedMealIngredient): GroundedIngredientData {
  const scale = item.amountG / 100;
  return {
    id: item.spoonacularIngredientId,
    name: item.ingredientName,
    caloriesPer100g: item.caloriesKcal / scale,
    proteinGPer100g: item.proteinG / scale,
    carbsGPer100g: item.carbsG / scale,
    fatGPer100g: item.fatG / scale,
    estimatedCostCentsPer100g: item.estimatedCostCents !== null ? item.estimatedCostCents / scale : null,
  };
}

// Placeholder density for a role composeMealFromProposalBestEffort's own
// relaxations already dropped (missing proposal, failed lookup, gap already
// closed) before refinement runs -- an all-zero density contributes nothing
// to any cross-term (amount x 0 = 0) and always fails refineRoleAmounts'
// own density<=0 guard, so a role that starts absent here stays absent
// through every refinement round rather than being revived.
const ZERO_DENSITY: GroundedIngredientData = {
  id: 0,
  name: "",
  caloriesPer100g: 0,
  proteinGPer100g: 0,
  carbsGPer100g: 0,
  fatGPer100g: 0,
  estimatedCostCentsPer100g: null,
};

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
    }
  | { kind: "title_ingredient_mismatch"; dishName: string; mismatchedWord: string }
  // F11 chat-driven meal editing only (composeMealFromEditDetailed below) --
  // an edit's ingredients always carry an EXPLICIT amountG (never solved
  // against a gap), so the failure shape is simpler than portion_out_of_bounds:
  // just "this stated amount is outside the realistic bound for this role,"
  // no gapNeeded to report since nothing was being solved for.
  | { kind: "amount_out_of_bounds"; role: MealRole; ingredientName: string; amountG: number; min: number; max: number };

// mealProposer.ts's TITLE_INGREDIENT_CHECK_FIELD asks Claude to self-check
// this, but never enforces it (validateProposal never reads the field's
// content) -- live-confirmed 2026-08-01, in ONE 35-slot plan: three fresh
// dinners titled "...with Rice"/"...with Quinoa"/"Tofu Steak..." whose real
// ingredients never included rice/quinoa/tofu at all, the exact same bug
// class as the persona audit's finding #6 (rice noodles), just with the
// self-check having failed silently again. A curated list of specific,
// unambiguous food-component words, not a generic "any noun not found in
// ingredients" check -- a broad heuristic would flag legitimate
// preparation/style words ("Skillet," "Crusted," "Mashed," "Roasted") as
// false mismatches, wasting this fallback's already-scarce AI-compose
// retry budget (see the persona audit's finding #3 and the 2026-08-01
// budget-vs-price backlog note) rejecting proposals that were never
// actually wrong. Deliberately excludes "toast"/"bagel"/"waffle"/"pancake"
// for the same reason -- these name a PREPARED FORM/finished baked good,
// not a raw purchasable ingredient (a pancake's real ingredients are
// flour/egg/milk, never an item literally called "pancake"), so including
// them false-flagged this codebase's own correct "...Whole Wheat Toast"
// fixture and would do the same to any real "...Waffles"/"...Pancakes"
// dish. Not exhaustive, but covers the common specific-protein/
// starch/dairy nouns this app's own proposals actually reach for, closing
// the exact failure class found live.
const SPECIFIC_INGREDIENT_WORDS = [
  "rice",
  "quinoa",
  "noodle",
  "pasta",
  "spaghetti",
  "couscous",
  "cheese",
  "tofu",
  "tempeh",
  "seitan",
  "chicken",
  "beef",
  "pork",
  "bacon",
  "ham",
  "turkey",
  "shrimp",
  "salmon",
  "tuna",
  "egg",
  "yogurt",
  "potato",
  "bean",
  "lentil",
  "chickpea",
  "avocado",
  "bread",
  "oat",
];

// Word-boundary match tolerant of a regular ("+s") or "-o"-ending irregular
// ("+es", e.g. potato/potatoes) plural -- every list entry above is a bare
// singular/base form, so this is the only pluralization handling needed.
// Same word-boundary idiom as aggregate.ts's wordBoundaryIncludes (kept as
// a local copy per this codebase's existing convention of a small per-file
// copy over a cross-module dependency for this exact string-matching
// shape).
function containsWord(haystack: string, word: string): boolean {
  return new RegExp(`\\b${word}(e?s)?\\b`).test(haystack);
}

// Exported (pure, no network) so it's directly unit-testable, matching
// this codebase's convention of testing the validator rather than the
// network call itself. Returns the first specific-ingredient word found in
// the dish name that has no corresponding match anywhere in the proposed
// ingredient names -- null when every specific-ingredient word mentioned in
// the title is actually backed by a real ingredient (the overwhelmingly
// common case).
export function findTitleIngredientMismatch(
  dishName: string,
  ingredients: Array<{ name: string }>,
): string | null {
  const titleLower = dishName.toLowerCase();
  const ingredientText = ingredients.map((i) => i.name.toLowerCase()).join(" ");
  for (const word of SPECIFIC_INGREDIENT_WORDS) {
    if (containsWord(titleLower, word) && !containsWord(ingredientText, word)) {
      return word;
    }
  }
  return null;
}

// Used only by composeMealFromProposalBestEffort below -- that composer can
// never reject (its whole purpose is "produce something rather than leave
// the slot blocked"), so a title/ingredient mismatch there can't be handled
// by the strict composer's reject-and-retry mechanism the way it is
// everywhere else. Live-confirmed 2026-08-01: best-effort explicitly
// tolerates a missing protein/carb/fat role (see this file's own
// `if (!proteinProposed) notes.push(...)`), which can orphan a title
// reference with no repair mechanism to catch it -- reproduced twice in one
// real generation ("Seitan and Kale Fried Rice..." with no seitan at all).
// Deterministically removes the mismatched word, preferring to also drop an
// adjacent " and "/"and " connector (the common "X and Y ..." title shape)
// so the result reads naturally; falls back to a bare word removal plus
// whitespace/dangling-connector cleanup when no adjacent connector exists.
// Never perfect English for every possible title shape, but always paired
// with a note in the caller's `notes` array (this function's own established
// disclosure idiom, already surfaced to the user via matchLabelFor's
// "Approximate — ..." label) -- an imperfect but honest correction beats an
// undisclosed wrong claim.
function stripMismatchedTitleWord(dishName: string, word: string): string {
  const w = `${word}(e?s)?`;
  let result = dishName
    .replace(new RegExp(`\\b${w}\\b\\s+and\\s+`, "i"), "")
    .replace(new RegExp(`\\s+and\\s+\\b${w}\\b`, "i"), "")
    .replace(new RegExp(`\\bwith\\s+${w}\\b`, "i"), "")
    .replace(new RegExp(`\\b${w}\\b`, "i"), "");
  result = result.replace(/\s{2,}/g, " ").trim();
  result = result.replace(/^(and|with)\s+/i, "").replace(/\s+(and|with)$/i, "");
  return result.trim();
}

// Repeatedly strips every mismatched word from the title against the FINAL
// composed ingredients (not the original proposal) -- best-effort's own
// role-dropping/lookup-failure relaxations happen after the proposal is
// first checked, so more than one title reference could end up orphaned in
// the same dish. Bounded at the length of the curated word list itself
// (SPECIFIC_INGREDIENT_WORDS), which is the real, finite ceiling on how many
// distinct mismatches a single title could ever produce -- guarantees
// termination without an arbitrary magic number.
export function stripAllTitleMismatches(dishName: string, ingredients: Array<{ name: string }>): { dishName: string; removedWords: string[] } {
  let name = dishName;
  const removedWords: string[] = [];
  for (let i = 0; i < SPECIFIC_INGREDIENT_WORDS.length; i++) {
    const mismatch = findTitleIngredientMismatch(name, ingredients);
    if (!mismatch) break;
    name = stripMismatchedTitleWord(name, mismatch);
    removedWords.push(mismatch);
  }
  return { dishName: name, removedWords };
}

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

  // Cheap, synchronous, checked before any network lookup below -- a
  // misleading title is wrong regardless of how well the ingredients
  // themselves would otherwise score.
  const mismatchedWord = findTitleIngredientMismatch(proposal.dishName, proposal.ingredients);
  if (mismatchedWord) {
    return { ok: false, reason: { kind: "title_ingredient_mismatch", dishName: proposal.dishName, mismatchedWord } };
  }

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
    const item = toComposedIngredient(lookup, amountG, "fixed");
    composed.push(item);
    remainingProtein -= item.proteinG;
    remainingCarbs -= item.carbsG;
    remainingFat -= item.fatG;
  }

  // Constant target for refineRoleAmounts below -- captured now, before
  // protein/carb/fat sizing mutates remainingProtein/Carbs/Fat in place.
  const fixedAdjustedTarget = { proteinG: remainingProtein, carbsG: remainingCarbs, fatG: remainingFat };

  // Starting point only -- protein is sized here against the FULL remaining
  // target without yet knowing the carb/fat roles' own protein content
  // (e.g. bread genuinely has ~12g protein/100g), so real total protein can
  // land meaningfully over target even though this role's own sizing is
  // individually correct. Carbs/fat ARE corrected for cross-contributions
  // in the other direction (each later role subtracts what earlier roles
  // already contributed) -- this asymmetry is exactly what the
  // refineRoleAmounts pass after the fat role below corrects, using the
  // same real ingredient densities already fetched here, no extra lookups.
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
  remainingCarbs -= (proteinLookup.carbsGPer100g / 100) * proteinSized.amountG;
  remainingFat -= (proteinLookup.fatGPer100g / 100) * proteinSized.amountG;

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
    remainingFat -= (carbLookup.fatGPer100g / 100) * carbSized.amountG;
  }

  const fatLookup = await fetchIngredientMacros(fatProposed.name);
  if (!fatLookup) {
    return { ok: false, reason: { kind: "ingredient_not_found", role: "fat", ingredientName: fatProposed.name } };
  }
  const fatSized = sizeForGap(fatLookup.fatGPer100g, remainingFat, PORTION_BOUNDS_G.fat.min);
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
  }

  // Refines the three amounts above (the "round 0" sequential solve) to
  // correct protein's directional overshoot -- see refineRoleAmounts' own
  // comment. Can only match or improve on round 0: it stops and returns
  // round 0's amounts unchanged the moment any refined amount would fall
  // outside a role's realistic bounds, so nothing rejected above can become
  // rejected here, and nothing accepted above can become unrealistic here.
  const refined = refineRoleAmounts(proteinLookup, carbLookup, fatLookup, fixedAdjustedTarget, {
    proteinAmountG: proteinSized.amountG,
    carbAmountG: carbSized?.amountG ?? null,
    fatAmountG: fatSized?.amountG ?? null,
  });

  const proteinItem = toComposedIngredient(proteinLookup, refined.proteinAmountG, "protein");
  composed.push(proteinItem);
  if (refined.carbAmountG !== null) {
    composed.push(toComposedIngredient(carbLookup, refined.carbAmountG, "carb"));
  }
  if (refined.fatAmountG !== null) {
    composed.push(toComposedIngredient(fatLookup, refined.fatAmountG, "fat"));
  }

  // Second, final title check against the ACTUAL composed ingredients --
  // not just the original proposal checked at the top of this function.
  // Live-confirmed 2026-08-01: the early check alone missed a real case --
  // a dish titled "...Brown Bean Buddha Bowl..." shipped with no bean
  // anywhere, because the proposal's "bean"-ish item was a `fixed`-role
  // garnish that passed the early check fine (it WAS in the proposal at
  // that point), then failed its Spoonacular lookup a few lines above and
  // was silently dropped (the fixed-item loop's own deliberate "don't
  // reject a whole good dish over one ungroundable garnish" rule, unrelated
  // to this check). Re-checking here, against composed's real final
  // ingredient names, catches exactly that gap. Reuses the SAME rejection
  // kind/retry-with-feedback path as the early check rather than silently
  // editing the title -- this fires rarely (only when a fixed item's own
  // title reference specifically fails lookup), so paying for one more
  // retry here is the same "reject late, retry" cost class this function
  // already accepts for portion_out_of_bounds, which also only fires after
  // grounding/sizing work is already done.
  const finalMismatch = findTitleIngredientMismatch(
    proposal.dishName,
    composed.map((i) => ({ name: i.ingredientName })),
  );
  if (finalMismatch) {
    return { ok: false, reason: { kind: "title_ingredient_mismatch", dishName: proposal.dishName, mismatchedWord: finalMismatch } };
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

export interface BestEffortComposeResult {
  meal: ComposedMeal;
  // True whenever ANY relaxation actually fired (a role got dropped,
  // clamped, or defaulted). False means this call succeeded via the exact
  // same rules as the strict composer -- callers should only disclose
  // "approximate" to a user when this is true, not unconditionally.
  isApproximate: boolean;
  approximationNotes: string[];
}

// Last-resort relaxed composer (2026-07-30, per Satya's explicit request:
// "fill with the closest meal rather than leaving it open"). Used ONLY
// after composeMealFromProposalDetailed has already failed on the SAME
// proposal (first attempt + retry, per orchestrate.ts's retry-with-
// feedback) -- never a replacement for the strict composer, only a final
// fallback so a slot doesn't stay blocked over a fixable-in-hindsight
// realism nitpick.
//
// SAFETY IS NEVER RELAXED. The unsafe-ingredient check below is byte-for-
// byte the same unconditional hard block as composeMealFromProposalDetailed
// -- there is no flag, no override, no path through this function that can
// return ok:true for a proposal containing an unsafe ingredient. Every
// OTHER rejection kind degrades gracefully instead of failing:
// - duplicate_role: keep the first ingredient for that role, drop the rest.
// - missing_role: proceed without that role's contribution (the meal comes
//   in light on that macro, disclosed, rather than not existing at all).
// - fixed_item_unrealistic: clamp the amount into bounds instead of
//   rejecting (matches the existing "just drop the whole fixed item on a
//   failed lookup" leniency already given to this non-critical role).
// - ingredient_not_found: drop that role's contribution (no real macro
//   data exists to build from, so there is nothing to size -- honest
//   omission, not a guess).
// - portion_infeasible / density too low to size anything: fall back to
//   this role's own realistic MINIMUM portion rather than omitting a
//   load-bearing (protein/carb) role entirely.
// - portion_out_of_bounds: clamp the computed amount to the nearest bound
//   instead of rejecting -- the amount was already real and computed, just
//   outside the realistic window, so clamping (not omitting) is the
//   honest "closest we can get" move.
export async function composeMealFromProposalBestEffort(
  proposal: MealProposal,
  target: MacroTargets,
  ctx: DietaryContext,
  fetchIngredientMacros: FetchIngredientMacrosFn,
): Promise<{ ok: true; result: BestEffortComposeResult } | { ok: false; reason: CompositionRejection }> {
  if (proposal.ingredients.length === 0) return { ok: false, reason: { kind: "no_ingredients" } };

  // Unconditional, same as the strict composer -- see the function-level
  // comment above for why this can never be bypassed.
  for (const ing of proposal.ingredients) {
    const unsafeReason = isOpenEndedIngredientUnsafeFor(ing.name, ctx);
    if (unsafeReason !== null) {
      return { ok: false, reason: { kind: "unsafe_ingredient", role: ing.role, ingredientName: ing.name, reason: unsafeReason } };
    }
  }

  const notes: string[] = [];

  // Duplicate role relaxed to "keep the first, drop the rest" instead of
  // rejecting the whole proposal.
  const seenCoreRoles = new Set<MealRole>();
  const dedupedIngredients: ProposedIngredient[] = [];
  for (const ing of proposal.ingredients) {
    if (ing.role !== "fixed") {
      if (seenCoreRoles.has(ing.role)) {
        notes.push(`used only the first proposed ${ing.role} ingredient (a duplicate was dropped)`);
        continue;
      }
      seenCoreRoles.add(ing.role);
    }
    dedupedIngredients.push(ing);
  }

  const proteinProposed = dedupedIngredients.find((i) => i.role === "protein");
  const carbProposed = dedupedIngredients.find((i) => i.role === "carb");
  const fatProposed = dedupedIngredients.find((i) => i.role === "fat");
  const fixedProposed = dedupedIngredients.filter((i) => i.role === "fixed");

  if (!proteinProposed && !carbProposed && !fatProposed) {
    // Nothing at all to build a real meal from -- genuinely nothing to
    // salvage, not a relaxable case.
    return { ok: false, reason: { kind: "missing_role", role: "protein" } };
  }
  if (!proteinProposed) notes.push(`no protein ingredient was proposed -- this meal will be light on protein`);
  if (!carbProposed) notes.push(`no carb ingredient was proposed -- this meal will be light on carbs`);
  if (!fatProposed) notes.push(`no fat ingredient was proposed -- this meal will be light on fat`);

  const composed: ComposedMealIngredient[] = [];
  let remainingProtein = target.proteinG;
  let remainingCarbs = target.carbsG;
  let remainingFat = target.fatG;

  for (const fixedItem of fixedProposed) {
    let amountG = fixedItem.fixedAmountG ?? DEFAULT_FIXED_AMOUNT_G;
    if (!Number.isFinite(amountG)) continue; // nothing sensible to clamp a NaN/Infinity to -- drop it, same as a failed lookup
    if (!isRealisticAmount(amountG, PORTION_BOUNDS_G.fixed)) {
      const clamped = Math.min(Math.max(amountG, PORTION_BOUNDS_G.fixed.min), PORTION_BOUNDS_G.fixed.max);
      notes.push(`adjusted "${fixedItem.name}" from ${amountG}g to a more realistic ${clamped}g`);
      amountG = clamped;
    }
    const lookup = await fetchIngredientMacros(fixedItem.name);
    if (!lookup) continue; // fixed items are non-critical -- same silent drop as the strict composer
    const item = toComposedIngredient(lookup, amountG, "fixed");
    composed.push(item);
    remainingProtein -= item.proteinG;
    remainingCarbs -= item.carbsG;
    remainingFat -= item.fatG;
  }

  // Constant target for the refinement pass after the three relaxedRoleItem
  // calls below -- captured now, before their own sequential sizing starts.
  const fixedAdjustedTarget = { proteinG: remainingProtein, carbsG: remainingCarbs, fatG: remainingFat };

  // Shared relaxed handling for a single core (protein/carb/fat) role --
  // grounds the ingredient, then sizes it with every failure mode
  // degrading instead of rejecting. Returns null only when there's
  // nothing at all to add (no ingredient proposed, or the gap is already
  // closed) -- an honest omission, not a failure.
  async function relaxedRoleItem(
    proposed: ProposedIngredient | undefined,
    role: Exclude<MealRole, "fixed">,
    remaining: number,
    // Matches the strict composer's own carb/fat exception exactly: those
    // two roles are legitimately allowed to contribute NOTHING (already
    // covered by an earlier role, or genuinely zero gap left) -- that's
    // not a compromise to relax, it's already-correct behavior in the
    // strict composer today. Only protein is mandatory there. Getting
    // this wrong would falsely disclose "approximate" on a proposal the
    // strict composer would have accepted outright.
    optional: boolean,
  ): Promise<ComposedMealIngredient | null> {
    if (!proposed) return null; // already noted above
    const lookup = await fetchIngredientMacros(proposed.name);
    if (!lookup) {
      notes.push(`"${proposed.name}" (${role}) couldn't be matched to real ingredient data and was dropped`);
      return null;
    }
    if (remaining <= 0) return null; // nothing needed -- correct omission, not a compromise, for every role

    const densityKey = role === "protein" ? "proteinGPer100g" : role === "carb" ? "carbsGPer100g" : "fatGPer100g";
    const density = lookup[densityKey];
    const bounds = PORTION_BOUNDS_G[role];

    if (density <= 0) {
      if (optional) return null; // same as the strict composer: sizeForGap would return null too, and this role may contribute nothing
      // Can't size ANY amount of this ingredient toward this macro at all
      // (e.g. proposed as "protein" but is macro-zero) -- fall back to a
      // realistic minimum portion rather than omitting a load-bearing role.
      notes.push(`"${proposed.name}" (${role}) can't meaningfully close the gap -- included at a normal minimum ${bounds.min}g portion instead`);
      return toComposedIngredient(lookup, bounds.min, role);
    }

    const sized = sizeForGap(density, remaining);
    if (!sized) {
      // Retry with this role's OWN, more permissive floor before falling
      // back to "not dense enough" -- see sizeForGap's own comment. A no-op
      // for protein/carb (bounds.min 20/15, already above the universal
      // floor sizeForGap defaulted to just above); only ever rescues a real,
      // small-but-legitimate fat amount (bounds.min=3) that the universal
      // 10g floor would otherwise have silently dropped.
      const rescued = bounds.min < MIN_INGREDIENT_AMOUNT_G ? sizeForGap(density, remaining, bounds.min) : null;
      if (rescued) return toComposedIngredient(lookup, rescued.amountG, role);
      if (optional) return null; // matches the strict composer's "allowed to contribute nothing" exception exactly -- not a compromise
      notes.push(`"${proposed.name}" (${role}) isn't dense enough to close the remaining gap -- included at a normal minimum ${bounds.min}g portion instead`);
      return toComposedIngredient(lookup, bounds.min, role);
    }
    // Persona audit 2026-07-31, finding #5 follow-up: needing drastically
    // more than the realistic ceiling (found live: parmesan cheese at
    // 3.22g carb/100g needed 410g against the 250g carb cap, 1.64x over --
    // clamping to 250g still delivered ~980 incidental kcal / 89g protein
    // / 65g fat from "the carb ingredient" alone, the exact shape of the
    // observed 1308-cal outlier) is a DIFFERENT failure mode than a
    // reasonable near-miss (the tofu-protein test below clamps a
    // 346g/280g-cap case, 1.24x over, and that's correctly left as a
    // clamp -- a genuinely close call, not a role-mismatched ingredient).
    // Deliberately NOT gated by `optional` the way the !sized branch above
    // is: sizeForGap succeeding here means a REAL, non-negligible gap
    // exists (unlike !sized's zero/negligible-need cases) -- this
    // ingredient just can't meaningfully close it, so it should still
    // contribute the honest minimum rather than silently nothing.
    if (sized.amountG > bounds.max * IMPLAUSIBLE_OVERAGE_MULTIPLIER) {
      notes.push(`"${proposed.name}" (${role}) isn't dense enough to close the remaining gap -- included at a normal minimum ${bounds.min}g portion instead`);
      return toComposedIngredient(lookup, bounds.min, role);
    }
    let amountG = sized.amountG;
    if (!isRealisticAmount(amountG, bounds)) {
      const clamped = Math.min(Math.max(amountG, bounds.min), bounds.max);
      notes.push(`"${proposed.name}" (${role}) needed ${amountG}g to fully close the gap -- capped at a realistic ${clamped}g instead`);
      amountG = clamped;
    }
    return toComposedIngredient(lookup, amountG, role);
  }

  let notesBefore = notes.length;
  let proteinItem = await relaxedRoleItem(proteinProposed, "protein", remainingProtein, false);
  const proteinWasRelaxed = notes.length > notesBefore;
  if (proteinItem) {
    remainingCarbs -= proteinItem.carbsG;
    remainingFat -= proteinItem.fatG;
  }

  notesBefore = notes.length;
  let carbItem = await relaxedRoleItem(carbProposed, "carb", remainingCarbs, true);
  const carbWasRelaxed = notes.length > notesBefore;
  if (carbItem) {
    remainingFat -= carbItem.fatG;
  }

  notesBefore = notes.length;
  let fatItem = await relaxedRoleItem(fatProposed, "fat", remainingFat, true);
  const fatWasRelaxed = notes.length > notesBefore;

  // Same directional protein-overshoot correction as the strict composer's
  // refineRoleAmounts (see that function's own comment) -- requires only
  // protein (the role that actually needs correcting; if it's absent there
  // is nothing to refine regardless), AND that none of the three roles
  // already needed a relaxedRoleItem note above (a clamp, a minimum-portion
  // substitution, "isn't dense enough"). Refining a role's amount after its
  // own note already described a specific clamped/substituted number would
  // make that note stale -- e.g. "needed 345g, capped at a realistic 280g
  // instead" would misdescribe a refined 255g result. Scoping refinement to
  // the case nothing needed that kind of note keeps every note accurate to
  // the FINAL delivered amount; a proposal that already needed one of these
  // relaxations keeps its pre-refinement amount and wording unchanged.
  //
  // A carb/fat role dropped by one of relaxedRoleItem's OTHER relaxations
  // (missing proposal, failed lookup, gap already closed -- none of which
  // describe a specific amount refinement could invalidate) gets a
  // zero-density placeholder instead of being excluded from refinement
  // entirely -- ZERO_DENSITY contributes nothing to any cross-term (amount
  // x 0 = 0) and its own sizeForGap call inside refineRoleAmounts always
  // returns null (density<=0 guard), so a genuinely-absent role stays
  // absent through every round rather than being revived.
  // Densities for a present role are reconstructed from round 0's own item
  // (reverseTo100g), not re-fetched -- the exact same real ingredient data,
  // no extra lookup.
  if (proteinItem && !proteinWasRelaxed && !carbWasRelaxed && !fatWasRelaxed) {
    const refined = refineRoleAmounts(
      reverseTo100g(proteinItem),
      carbItem ? reverseTo100g(carbItem) : ZERO_DENSITY,
      fatItem ? reverseTo100g(fatItem) : ZERO_DENSITY,
      fixedAdjustedTarget,
      { proteinAmountG: proteinItem.amountG, carbAmountG: carbItem?.amountG ?? null, fatAmountG: fatItem?.amountG ?? null },
    );
    proteinItem = toComposedIngredient(reverseTo100g(proteinItem), refined.proteinAmountG, "protein");
    carbItem = carbItem && refined.carbAmountG !== null ? toComposedIngredient(reverseTo100g(carbItem), refined.carbAmountG, "carb") : null;
    fatItem = fatItem && refined.fatAmountG !== null ? toComposedIngredient(reverseTo100g(fatItem), refined.fatAmountG, "fat") : null;
  }

  if (proteinItem) composed.push(proteinItem);
  if (carbItem) composed.push(carbItem);
  if (fatItem) composed.push(fatItem);

  if (composed.length === 0) {
    // Every single ingredient failed to resolve -- genuinely nothing real
    // to show, still fails closed here rather than presenting an empty dish.
    return { ok: false, reason: { kind: "ingredient_not_found", role: "protein", ingredientName: proteinProposed?.name ?? carbProposed?.name ?? fatProposed?.name ?? "unknown" } };
  }

  // Best-effort's own role-dropping/lookup-failure relaxations above can
  // orphan a title reference the original proposal-time wording never had a
  // chance to avoid -- see stripAllTitleMismatches' comment. Checked
  // against the FINAL composed ingredient names, not the original proposal,
  // for the same reason the strict composer's own second check does.
  const { dishName: correctedDishName, removedWords } = stripAllTitleMismatches(
    proposal.dishName,
    composed.map((i) => ({ name: i.ingredientName })),
  );
  for (const word of removedWords) {
    notes.push(`dish name no longer mentions "${word}" -- it wasn't actually included as an ingredient`);
  }

  const anyCostUnknown = composed.some((i) => i.estimatedCostCents === null);
  return {
    ok: true,
    result: {
      meal: {
        dishName: correctedDishName,
        ingredients: composed,
        totalCalories: composed.reduce((s, i) => s + i.caloriesKcal, 0),
        totalProteinG: composed.reduce((s, i) => s + i.proteinG, 0),
        totalCarbsG: composed.reduce((s, i) => s + i.carbsG, 0),
        totalFatG: composed.reduce((s, i) => s + i.fatG, 0),
        totalEstimatedCostCents: !anyCostUnknown ? composed.reduce((s, i) => s + (i.estimatedCostCents ?? 0), 0) : null,
      },
      isApproximate: notes.length > 0,
      approximationNotes: notes,
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
    case "title_ingredient_mismatch":
      return `Your dish name "${reason.dishName}" mentions "${reason.mismatchedWord}" but that isn't one of your listed ingredients. Either remove that word from the dish name, or add it as a real ingredient.`;
    case "amount_out_of_bounds":
      return `"${reason.ingredientName}" (${reason.role}) at ${Math.round(reason.amountG)}g isn't a realistic amount for this role (needs to be ${reason.min}-${reason.max}g). Give it a realistic amount instead.`;
  }
}

// User-facing sibling to describeRejectionForFeedback above -- that one is
// written FOR Claude (a retry-with-feedback prompt, internal field names
// like "role"/"gapNeeded" are fine); this one is written FOR the chat
// user reading sendChatMessage's reply text directly, so it stays in
// plain second-person language with no internal jargon.
export function describeRejectionForChatUser(reason: CompositionRejection): string {
  switch (reason.kind) {
    case "no_ingredients":
      return "I couldn't make sense of that edit -- it didn't end up with any ingredients.";
    case "unsafe_ingredient":
      return `I can't do that -- "${reason.ingredientName}" ${reason.reason}.`;
    case "duplicate_role":
      return `That edit ended up with more than one ${reason.role} ingredient, which I can't size correctly -- try naming just one.`;
    case "missing_role":
      return `That edit is missing a ${reason.role} ingredient.`;
    case "fixed_item_unrealistic":
      return `"${reason.ingredientName}" at ${Math.round(reason.amountG)}g isn't a realistic side/garnish amount.`;
    case "ingredient_not_found":
      return `I couldn't find real nutrition data for "${reason.ingredientName}" -- try a more common ingredient name.`;
    case "portion_infeasible":
      return `"${reason.ingredientName}" isn't dense enough to make that change work in a realistic portion.`;
    case "portion_out_of_bounds":
      return `"${reason.ingredientName}" would need an unrealistic amount to make that change work.`;
    case "title_ingredient_mismatch":
      return `That edit's dish name mentions "${reason.mismatchedWord}", but that's not actually one of the ingredients.`;
    case "amount_out_of_bounds": {
      // Live-confirmed 2026-08-09: the leading phrase used to hardcode
      // "That's more X than fits..." regardless of which bound was
      // actually violated -- for an under-the-minimum amount (a tiny,
      // near-zero portion), this read backwards ("more" when the real
      // problem is there's barely any of it), even though the trailing
      // parenthetical already correctly distinguished max vs min.
      const over = reason.amountG > reason.max;
      return `That's ${over ? "more" : "less"} ${reason.ingredientName} than fits in a realistic portion (${Math.round(reason.amountG)}g, ${
        over ? `the realistic max is ${reason.max}g` : `the realistic minimum is ${reason.min}g`
      }).`;
    }
  }
}

// Case/whitespace-insensitive, order-insensitive (multiset) comparison --
// an edit that reproduces the current ingredient list (same names, same
// amounts within a small tolerance) is a no-op worth telling the user
// about explicitly rather than silently "succeeding" at doing nothing.
const NO_OP_AMOUNT_TOLERANCE_G = 1;

export function isNoOpEdit(
  current: Array<{ name: string; amountG: number }>,
  proposedMeal: ComposedMeal,
): boolean {
  if (current.length !== proposedMeal.ingredients.length) return false;

  const remaining = [...proposedMeal.ingredients];
  for (const currentItem of current) {
    const matchIndex = remaining.findIndex(
      (p) =>
        p.ingredientName.trim().toLowerCase() === currentItem.name.trim().toLowerCase() &&
        Math.abs(p.amountG - currentItem.amountG) < NO_OP_AMOUNT_TOLERANCE_G,
    );
    if (matchIndex === -1) return false;
    remaining.splice(matchIndex, 1);
  }
  return true;
}

export type ComposeEditResult = { ok: true; meal: ComposedMeal } | { ok: false; reason: CompositionRejection };

// F11 chat-driven meal editing. Reuses every existing grounding/safety
// helper from composeMealFromProposalDetailed above, but is deliberately
// NOT a variant of it -- an edit never solves an amount against a macro
// target (every amountG here is already explicit, from the edit
// proposal), so there is no protein-then-carb-then-fat sequential solve
// and no refineRoleAmounts pass. Safety is identical and unconditional
// (never relaxed, same as both existing composers). Deliberately no
// missing_role check -- unlike a fresh composition, an edit may
// legitimately drop a role entirely ("drop the rice from tonight's
// dinner" is a valid outcome, not a malformed proposal).
//
// Word-set matching for preExistingIngredientNames below, NOT exact string
// equality -- live-confirmed the exact-match version doesn't work at all
// for the real repro it exists to fix: a real Spoonacular recipe's stored
// ingredient name can carry the source's own quantity shorthand (e.g.
// "bot beer", "pkt firm/extra tofu" -- "bot"/"pkt" abbreviate a serving
// container, not a food name), while the edit proposer is explicitly
// instructed to return "real, specific, searchable ingredient names," so
// it reasonably re-lists that same ingredient as plain "beer". An exact
// match against the raw stored name never fires for exactly the case this
// exists to catch. Subset-of-words (either direction) catches this
// ("beer" is fully contained in "bot beer") while still guarding against
// a real false-positive risk: plain substring containment would wrongly
// treat a genuinely NEW "egg" as pre-existing just because the recipe
// already had "eggplant" -- word-level comparison doesn't have that
// collision ("egg" is not one of "eggplant"'s words). Splits on "/" as
// well as whitespace -- live-confirmed 2026-08-09, same repro: the exact
// same "pkt firm/extra tofu" carries a literal "/" that Spoonacular's own
// search doesn't tokenize across either (see slashToSpaceFallback in
// spoonacular.ts). A whitespace-only split leaves "firm/extra" as one
// token, so ["firm","tofu"] (the proposer's own re-listed, shortened
// name) is never a subset of ["pkt","firm/extra","tofu"] -- "firm" never
// exact-matches "firm/extra". Splitting on "/" too makes both sides
// tokenize the same way ("pkt","firm","extra","tofu"), so the subset
// check works as intended again.
function nameWords(name: string): string[] {
  return name.trim().toLowerCase().split(/[\s/]+/).filter(Boolean);
}

function isWordSubsetEitherWay(a: string[], b: string[]): boolean {
  const isSubset = (small: string[], big: string[]) => small.every((w) => big.includes(w));
  return isSubset(a, b) || isSubset(b, a);
}

// preExistingIngredientNames (live bug found 2026-08-09, real-user chat
// testing against production): the proposer always returns the COMPLETE
// ingredient list, re-listing untouched ingredients alongside whatever
// actually changed (see mealEditProposer.ts's own schema doc). For a real
// Spoonacular-recipe-sourced slot, those untouched ingredients can be
// recipe-scale cooking components (a braising liquid, a soup base) that
// the model has to force into one of the four AI-composed roles even
// though they were never meant to be sized like one, AND can be described
// in a way Spoonacular's own free-text ingredient search doesn't
// recognize even though the recipe's structured data already links it to
// a real ingredient id -- live-confirmed, both in the same real repro:
// editing "Mushroom Tofu Stew" (asking to add chicken) never even reached
// the requested ingredient because the recipe's own pre-existing "beer"
// (re-expressed at 426.6g) first tripped the `fixed` role's 150g cap
// (meant for AI-composed garnish-scale amounts, not a recipe's own
// cooking liquid), and separately its "strong mushroom broth" (Spoonacular
// itself calls the same real ingredient "stock" -- confirmed directly
// against the search API, "mushroom broth" returns zero results under any
// phrasing) failed to ground at all. Both resulting refusals named an
// ingredient the user never asked about, never addressing the actual
// request. A THIRD live case in the same repro, after fixing the first
// two: the same recipe's pre-existing "carrots" (a `carb`-role ingredient,
// not `fixed`) also tripped its own role's bounds once re-expressed --
// proving this isn't a `fixed`-role-specific problem, it's a general
// consequence of forcing a real recipe's own already-legitimate amounts
// through bounds tuned for AI-composed single-serving norms, regardless
// of role.
//
// So: an ingredient that already existed in the meal before this edit
// ALWAYS skips the out-of-bounds check (any role) -- its amount isn't a
// new judgment being introduced, it's a real recipe's own pre-existing
// data, so the realism bound (which exists to catch a genuinely invented
// outlier) doesn't apply to it in the first place. A failed LOOKUP,
// however, is only forgiven (dropped from the result) for `fixed` role --
// `fixed` is documented above as "isn't macro-solved" (a garnish/aromatic,
// low-stakes by design), so dropping one is a minor omission; silently
// dropping a pre-existing protein/carb/fat ingredient that fails to
// ground would misrepresent the meal's actual macro totals, a
// meaningfully worse outcome this app's own macro-accuracy guarantee
// doesn't accept -- that case still hard-rejects exactly as before. Both
// relaxations are unconditional on safety (still runs through
// isOpenEndedIngredientUnsafeFor above regardless) and only ever apply to
// an ingredient genuinely already in the meal -- a NEW ingredient of any
// role, in either failure mode, is held to the full original standard.
export async function composeMealFromEditDetailed(
  edit: MealEditProposal,
  ctx: DietaryContext,
  fetchIngredientMacros: FetchIngredientMacrosFn,
  preExistingIngredientNames: string[] = [],
): Promise<ComposeEditResult> {
  const preExistingWordSets = preExistingIngredientNames.map(nameWords).filter((w) => w.length > 0);
  const isPreExistingIngredient = (name: string): boolean => {
    const words = nameWords(name);
    if (words.length === 0) return false;
    return preExistingWordSets.some((existingWords) => isWordSubsetEitherWay(words, existingWords));
  };
  if (edit.ingredients.length === 0) return { ok: false, reason: { kind: "no_ingredients" } };

  const mismatchedWord = findTitleIngredientMismatch(edit.dishName, edit.ingredients);
  if (mismatchedWord) {
    return { ok: false, reason: { kind: "title_ingredient_mismatch", dishName: edit.dishName, mismatchedWord } };
  }

  for (const ing of edit.ingredients) {
    const unsafeReason = isOpenEndedIngredientUnsafeFor(ing.name, ctx);
    if (unsafeReason !== null) {
      return { ok: false, reason: { kind: "unsafe_ingredient", role: ing.role, ingredientName: ing.name, reason: unsafeReason } };
    }
  }

  for (const role of ["protein", "carb", "fat"] as const) {
    if (edit.ingredients.filter((i) => i.role === role).length > 1) {
      return { ok: false, reason: { kind: "duplicate_role", role } };
    }
  }

  const composed: ComposedMealIngredient[] = [];
  for (const ing of edit.ingredients) {
    const isPreExisting = isPreExistingIngredient(ing.name);
    const lookup = await fetchIngredientMacros(ing.name);
    if (!lookup) {
      // Live-confirmed 2026-08-09: a pre-existing fixed-role ingredient can
      // fail lookup for a real, unrelated-to-this-fix reason -- "strong
      // mushroom broth" isn't findable by ANY free-text search Spoonacular
      // recognizes (confirmed directly against the search API), even
      // though the recipe's own structured data already links it to a
      // real ingredient id ("stock"). Rather than block the whole edit
      // over an ingredient the user never asked about, drop it -- same
      // "isn't macro-solved, low-stakes by design" reasoning as the bounds
      // relaxation just below. Deliberately NOT extended to protein/carb/
      // fat even when pre-existing (unlike the bounds relaxation just
      // below) -- silently dropping one of those would misrepresent the
      // meal's actual macro totals, a materially worse outcome than
      // dropping a fixed-role garnish/liquid that was never macro-solved
      // to begin with. A genuinely NEW ingredient of any role still
      // hard-rejects here exactly as before.
      if (isPreExisting && ing.role === "fixed") continue;
      return { ok: false, reason: { kind: "ingredient_not_found", role: ing.role, ingredientName: ing.name } };
    }
    const bounds = PORTION_BOUNDS_G[ing.role];
    if (!isPreExisting && !isRealisticAmount(ing.amountG, bounds)) {
      return {
        ok: false,
        reason: { kind: "amount_out_of_bounds", role: ing.role, ingredientName: ing.name, amountG: ing.amountG, min: bounds.min, max: bounds.max },
      };
    }
    composed.push(toComposedIngredient(lookup, ing.amountG, ing.role));
  }

  // Guards the pre-existing-fixed-item drop above: if literally every
  // ingredient in the edit was a dropped pre-existing fixed item (no
  // protein/carb/fat, no new fixed item that grounded successfully),
  // there's nothing left to compose -- same rejection as the empty-input
  // check at the top of this function, just reached a different way.
  if (composed.length === 0) return { ok: false, reason: { kind: "no_ingredients" } };

  // Second, final title check against the ACTUAL composed ingredient
  // names -- same rationale as composeMealFromProposalDetailed's own
  // second check. Unlike when this comment was first written, a
  // pre-existing fixed item's failed lookup CAN now silently drop it (see
  // above), so this also catches the dish name still referencing an
  // ingredient that got dropped, not just a hypothetical case.
  const finalMismatch = findTitleIngredientMismatch(
    edit.dishName,
    composed.map((i) => ({ name: i.ingredientName })),
  );
  if (finalMismatch) {
    return { ok: false, reason: { kind: "title_ingredient_mismatch", dishName: edit.dishName, mismatchedWord: finalMismatch } };
  }

  const anyCostUnknown = composed.some((i) => i.estimatedCostCents === null);
  return {
    ok: true,
    meal: {
      dishName: edit.dishName,
      ingredients: composed,
      totalCalories: composed.reduce((s, i) => s + i.caloriesKcal, 0),
      totalProteinG: composed.reduce((s, i) => s + i.proteinG, 0),
      totalCarbsG: composed.reduce((s, i) => s + i.carbsG, 0),
      totalFatG: composed.reduce((s, i) => s + i.fatG, 0),
      totalEstimatedCostCents: !anyCostUnknown ? composed.reduce((s, i) => s + (i.estimatedCostCents ?? 0), 0) : null,
    },
  };
}
