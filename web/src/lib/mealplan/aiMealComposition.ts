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
    }
  | { kind: "title_ingredient_mismatch"; dishName: string; mismatchedWord: string };

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
    const item = toComposedIngredient(lookup, amountG);
    composed.push(item);
    remainingProtein -= item.proteinG;
    remainingCarbs -= item.carbsG;
    remainingFat -= item.fatG;
  }

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
      return toComposedIngredient(lookup, bounds.min);
    }

    const sized = sizeForGap(density, remaining);
    if (!sized) {
      if (optional) return null; // matches the strict composer's "allowed to contribute nothing" exception exactly -- not a compromise
      notes.push(`"${proposed.name}" (${role}) isn't dense enough to close the remaining gap -- included at a normal minimum ${bounds.min}g portion instead`);
      return toComposedIngredient(lookup, bounds.min);
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
      return toComposedIngredient(lookup, bounds.min);
    }
    let amountG = sized.amountG;
    if (!isRealisticAmount(amountG, bounds)) {
      const clamped = Math.min(Math.max(amountG, bounds.min), bounds.max);
      notes.push(`"${proposed.name}" (${role}) needed ${amountG}g to fully close the gap -- capped at a realistic ${clamped}g instead`);
      amountG = clamped;
    }
    return toComposedIngredient(lookup, amountG);
  }

  const proteinItem = await relaxedRoleItem(proteinProposed, "protein", remainingProtein, false);
  if (proteinItem) {
    composed.push(proteinItem);
    remainingCarbs -= proteinItem.carbsG;
    remainingFat -= proteinItem.fatG;
  }

  const carbItem = await relaxedRoleItem(carbProposed, "carb", remainingCarbs, true);
  if (carbItem) {
    composed.push(carbItem);
    remainingFat -= carbItem.fatG;
  }

  const fatItem = await relaxedRoleItem(fatProposed, "fat", remainingFat, true);
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
  }
}
