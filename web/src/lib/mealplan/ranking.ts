// Epic E2 (F3) — deterministic candidate ranking (OQ2/OQ7). No LLM: this is
// a plain weighted-deviation score, budget-first ordering for Pro, and a
// cheapest-macro-match fallback when no candidate is budget-compliant.

import { classifyTier, type ToleranceTier } from "./tolerance";
import { pantryCoverage, type PantryRemainingTracker } from "./pantryRemaining";

export interface CandidateIngredient {
  id: number;
  name: string;
  amount: number;
  unit: string;
  metricAmount: number;
  metricUnit: string;
}

export interface RecipeCandidate {
  id: number;
  title: string;
  imageUrl: string | null;
  servings: number;
  proteinG: number; // per serving
  caloriesKcal: number; // per serving
  carbsG: number; // per serving
  fatG: number; // per serving
  pricePerServingCents: number | null;
  aggregateLikes: number;
  ingredients: CandidateIngredient[];
}

// F6/F3 pantry-aware querying. spoonacularIngredientId is resolved lazily
// (F6 is manual-entry-first) — null until resolved, in which case matching
// falls back to a loose name comparison (see pantryOverlapDeduction below).
// amount/unit (migration 0018) are an OPTIONAL structured quantity -- null
// when a pantry entry only ever had free-text quantity_text (the common
// case, F6 quantity entry is optional), in which case pantryRemaining.ts
// treats this item as an unlimited pool (today's exact boolean behavior,
// never depletes) rather than guessing at a quantity that was never given.
export interface PantryItem {
  name: string;
  spoonacularIngredientId: number | null;
  amount: number | null;
  unit: string | null;
}

export interface RankedCandidate extends RecipeCandidate {
  score: number;
  budgetCompliant: boolean;
  // Real p10/p20/p30 classification against the true per-meal target
  // (null if outside even p30) — independent of which tier's bounds the
  // candidate happened to be fetched with (cascade.ts fetches at the
  // widest tier by default, so a fetched pool mixes candidates of
  // different real qualities; this is what makes the persisted label
  // honest per-candidate rather than per-fetch).
  actualTier: ToleranceTier | null;
  isFallbackOfLastResort: boolean;
  // Set only by aiMealComposition.ts's candidates -- distinguishes an
  // AI-composed MEAL (real dish name + ingredient list, recipe_source
  // 'ai_composed') from a plain composed SNACK (recipe_source
  // 'composed') even though both use a synthetic negative id.
  aiComposed?: boolean;
  // Portion scaling (Epic E2 follow-up, July 20 2026 spec): the multiplier
  // applied to the candidate's native per-serving macros/price/servings to
  // better fit `target`. 1 means unscaled. Every other field on this
  // RankedCandidate (proteinG, caloriesKcal, carbsG, fatG,
  // pricePerServingCents, servings) already reflects the SCALED value, not
  // the original RecipeCandidate's native one -- scaleFactor exists so the
  // native value stays recoverable (amount / scaleFactor) and so it can be
  // persisted for display/debugging.
  scaleFactor: number;
}

// Protein weighted 2x, carbs/fat weighted 0.5x, per F1's macro-split
// priority (PRD 7.3) plus a live-data-informed carb/fat weight. Lower is
// better; 0 = exact match.
//
// An earlier version scored protein/calories only, with carb/fat handled
// as a separate discrete "compliant" preference that only broke near-ties.
// Verified live that this was too weak to matter in practice: real
// carb/fat-compliant candidates and top protein/calorie matches turned out
// to be almost entirely disjoint sets for a real "cut" profile, so the
// preference never actually promoted them — 0/21 claimed slots ended up
// carb/fat compliant despite 6/40 being available in the pool. Blending
// carb/fat directly into the score (this version) is what actually moved
// the needle: simulated against the real cached pool, weight 0 → carbs
// -44%/fat +48% off target; weight 0.5 → fat +2%, carbs -10%, with
// protein/calories giving up only ~5-6 points of precision in exchange.
// 0.5 was chosen as a round, generalizable value over a profile-specific
// grid-search optimum (which risked overfitting one data point).
const CARB_FAT_WEIGHT = 0.5;

// A target of exactly 0 (reachable for carbsG/fatG on a real extreme-cut
// profile -- tdee.ts clamps carbsG to 0 when protein+fat calories consume
// the whole daily budget) used to divide by zero: a perfect-fit candidate
// (also 0) scored NaN, and any imperfect candidate scored Infinity,
// breaking the sort comparator's contract entirely. Found live July 16
// 2026 (comprehensive engine test). A target of 0 with a 0 candidate
// value is a perfect match (0 deviation); a target of 0 with ANY nonzero
// candidate value is treated as a full (100%) deviation on that macro --
// bounded, not infinite, so it still ranks worse than any real percentage
// deviation without blowing up the comparator.
//
// Sibling gap, found live 2026-07-27 root-causing small_body_aggressive_cut's
// fat-deviation regression: a target that's small but NOT zero has the same
// blow-up shape as the zero case, just bounded instead of infinite. A
// small-body, aggressive-cut profile's per-meal fat share (targets.ts's
// MEAL_TYPE_SHARE splitting an already-tight daily fat budget across 5
// meals) can be as little as ~5g -- and any ordinary real recipe's
// unavoidable incidental fat content then reads as 60-100%+ "off," even
// though the absolute miss is a few grams and nutritionally irrelevant.
// This let real, meaningful improvements to protein/calories fit (the
// this-session guards' actual optimization target) get bundled with a fat
// increase that looked catastrophic in relative terms but wasn't in
// absolute ones.
//
// Fixed by flooring the DENOMINATOR, not subtracting a flat amount from the
// numerator -- tried that first and reverted: sized large enough to matter
// for a ~5g target, a subtract-based floor zeroed out real, meaningful
// deviations on this file's own smallest already-tested normal target (15g
// fat, the "weights carbs/fat deviation at 0.5x" test below). Flooring the
// denominator instead leaves any target AT OR ABOVE the floor completely
// unchanged -- provably safe for every currently-tested profile, since the
// smallest real target anywhere in this file's test suite is 15g/500kcal,
// both above MIN_TARGET_G/MIN_TARGET_KCAL below -- and only softens the
// case where the target itself is tinier than these thresholds.
const MIN_TARGET_G = 8;
const MIN_TARGET_KCAL = 40;

function safeRelativeDeviation(candidateValue: number, targetValue: number, minTarget: number): number {
  if (targetValue === 0) return candidateValue === 0 ? 0 : 1;
  return Math.abs(candidateValue - targetValue) / Math.max(targetValue, minTarget);
}

export function macroDeviationScore(
  candidate: { proteinG: number; caloriesKcal: number; carbsG: number; fatG: number },
  target: { proteinG: number; calories: number; carbsG: number; fatG: number },
): number {
  const proteinDeviation = safeRelativeDeviation(candidate.proteinG, target.proteinG, MIN_TARGET_G) * 2;
  const caloriesDeviation = safeRelativeDeviation(candidate.caloriesKcal, target.calories, MIN_TARGET_KCAL);
  const carbsDeviation = safeRelativeDeviation(candidate.carbsG, target.carbsG, MIN_TARGET_G) * CARB_FAT_WEIGHT;
  const fatDeviation = safeRelativeDeviation(candidate.fatG, target.fatG, MIN_TARGET_G) * CARB_FAT_WEIGHT;
  return proteinDeviation + caloriesDeviation + carbsDeviation + fatDeviation;
}

// Portion scaling (July 20 2026 spec, following the head-to-head Prospre
// comparison): Spoonacular's native per-serving macros are treated today as
// a fixed, unscalable amount, but real recipes can realistically be served
// at more or less than one native serving. macroDeviationScore is a sum of
// terms each piecewise-linear (and, since each |.| term is convex and the
// weights are positive, convex overall) in `scale`, so its true minimum is
// always attained either at scale=1 (no scaling) or at one of the 4
// per-macro "perfect fit" breakpoints (target_i / candidate_i) -- no
// numerical search needed, just evaluate the (clamped) breakpoints and
// scale=1, keep the best. Always scoring scale=1 as one of the candidates
// guarantees this can never pick something worse than today's unscaled
// behavior.
const MIN_SCALE = 0.6;
const MAX_SCALE = 1.6;

export function bestScaleAndScore(
  candidate: { proteinG: number; caloriesKcal: number; carbsG: number; fatG: number },
  target: { proteinG: number; calories: number; carbsG: number; fatG: number },
): { scale: number; score: number } {
  const breakpoints = [1];
  for (const [c, t] of [
    [candidate.proteinG, target.proteinG],
    [candidate.caloriesKcal, target.calories],
    [candidate.carbsG, target.carbsG],
    [candidate.fatG, target.fatG],
  ] as const) {
    if (c > 0) breakpoints.push(t / c);
  }

  let best = { scale: 1, score: macroDeviationScore(candidate, target) };
  for (const raw of breakpoints) {
    if (!Number.isFinite(raw)) continue;
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, raw));
    const scaled = {
      proteinG: candidate.proteinG * scale,
      caloriesKcal: candidate.caloriesKcal * scale,
      carbsG: candidate.carbsG * scale,
      fatG: candidate.fatG * scale,
    };
    const score = macroDeviationScore(scaled, target);
    if (score < best.score) best = { scale, score };
  }
  return best;
}

// PRD 7.3 F3: pantry overlap is "a small deduction" that "never overrides
// macro/dietary/allergen constraints, it only biases which matching recipe
// is preferred" — so this is capped well below a single real protein/
// calorie deviation point (contrast CARB_FAT_WEIGHT above, which is an
// acknowledged real precision tradeoff, not a tiebreak-only nudge).
// Deliberately NOT sent to Spoonacular as includeIngredients (unlike diet/
// intolerances/excludeIngredients): pantry contents are per-user and would
// fragment the cross-user recipe_query_cache (cacheKey.ts) to near-zero
// hit rate the same way excludeIds already deliberately stays out of the
// key — same tradeoff already made for carb/fat bounds in spoonacular.ts.
const PANTRY_OVERLAP_WEIGHT = 0.02;
const MAX_PANTRY_OVERLAP_DEDUCTION = 0.06;

// Word-boundary matching (not a bare bidirectional substring check -- the
// "pea"/"peanut oil", "egg"/"eggplant" false-positive class found live
// July 15 2026) and quantity-aware coverage/depletion both now live in
// pantryRemaining.ts, shared with this function via PantryRemainingTracker
// -- kept out of this file so ranking.ts's own "No LLM, no network" scoring
// path never needs to know about identity-match/unit-conversion resolution,
// only about reading an already-resolved tracker.
function pantryOverlapDeduction(
  scaledIngredients: CandidateIngredient[],
  pantryTracker: PantryRemainingTracker,
): number {
  if (pantryTracker.pools.length === 0 || scaledIngredients.length === 0) return 0;
  const matched = pantryCoverage(pantryTracker, scaledIngredients).filter(Boolean).length;
  return Math.min(matched * PANTRY_OVERLAP_WEIGHT, MAX_PANTRY_OVERLAP_DEDUCTION);
}

export interface RankCandidatesOptions {
  tier: "free" | "pro";
  budgetPerMealUsd: number | null;
  // Quantity-aware, mutable pantry state (pantryRemaining.ts) -- depletes
  // as slots get claimed elsewhere (orchestrate.ts), so later calls in the
  // same generation pass see less availability than earlier ones. Omitted
  // (or a tracker with zero pools) degrades to "no pantry bias," same as
  // omitting pantryItems did before this existed.
  pantryTracker?: PantryRemainingTracker;
}

// Budget-compliant candidates ranked first (Pro only, and only when a
// budget is actually set); ties broken by cheapest then highest
// aggregateLikes. Non-compliant candidates are demoted to the back of the
// list, never dropped — claim-resolution (OQ7) needs the full pool to step
// through on collisions across 21 slots, and discarding non-compliant
// candidates whenever at least one compliant one exists would starve every
// slot but the first few once the compliant subset is exhausted (this was
// the actual cause of a "only 2 of 21 meals generated" bug: a tight budget
// left only 1-2 compliant candidates, and the rest of the pool used to get
// thrown away entirely). If literally none are budget-compliant, the single
// cheapest macro-matching candidate is still flagged as the fallback of
// last resort so budget alone never blocks generation (PRD OQ2/F3 budget
// cascade) — but again, without discarding the rest of the pool.
export function rankCandidates(
  candidates: RecipeCandidate[],
  target: { proteinG: number; calories: number; carbsG: number; fatG: number },
  opts: RankCandidatesOptions,
): RankedCandidate[] {
  const budgetAware = opts.tier === "pro" && opts.budgetPerMealUsd !== null;
  const budgetLimitCents = budgetAware ? opts.budgetPerMealUsd! * 100 : null;
  const pantryTracker = opts.pantryTracker ?? { pools: [] };

  const scored = candidates.map((candidate) => {
    const { scale, score } = bestScaleAndScore(candidate, target);
    // Every macro/price/servings field below is scaled -- classifyTier,
    // budgetCompliant, and every downstream reader of this RankedCandidate
    // (matchLabelFor, daily/weekly actual-summing, reconciliation, and
    // F4's grocery list which sums `ingredients` amounts directly) must
    // all see what was actually picked, not the native Spoonacular amount.
    // Found live 2026-07-24: `ingredients` was the one field NOT scaled
    // here, so the grocery list and pricePerServingCents-based budget
    // check silently described different quantities of the same recipe
    // for any slot where scale != 1 (the common case).
    //
    // Ingredients scale by (scale / candidate.servings), NOT scale alone --
    // confirmed live against real persisted data (a "Makes 2 servings"
    // pancake recipe, scale~1.02, was persisting 3.07 eggs/253g ricotta,
    // its full 2-serving batch barely nudged by scale, not the ~1.5
    // eggs/127g ricotta one meal occurrence actually needs). Spoonacular's
    // extendedIngredients amounts are for the recipe's ENTIRE native batch
    // (candidate.servings, before scaling) -- one meal-plan slot only
    // represents eating `scale` serving-equivalents of it, so the
    // ingredient amount needed is the per-native-serving amount
    // (amount / candidate.servings) times how many serving-equivalents
    // this meal actually needs (scale).
    //
    // servings is `scale` alone, NOT candidate.servings * scale -- bug
    // found live 2026-07-25 alongside the ingredients one above, same root
    // cause (conflating the native batch size with the scale factor).
    // Cooking (scale / candidate.servings) of a candidate.servings-serving
    // recipe yields candidate.servings * (scale / candidate.servings) =
    // scale servings of food, by construction -- exactly what this one
    // meal-plan slot represents eating. The old `candidate.servings *
    // scale` double-counted the native serving count: a perfect match
    // (scale = 1, i.e. this slot's target IS one standard serving, zero
    // leftovers) still showed "Makes {candidate.servings} servings — cook a
    // fraction or plan for leftovers" for any recipe with more than one
    // native serving (the common case), even though the correctly-scaled
    // ingredients above only ever produce one serving's worth of food in
    // that scenario. MIN_SCALE/MAX_SCALE (0.6-1.6) confirm `scale` alone is
    // the right shape here -- it's always in the "about one serving"
    // neighborhood, never a multi-day-batch-sized number.
    const scaledCandidate = {
      ...candidate,
      proteinG: candidate.proteinG * scale,
      caloriesKcal: candidate.caloriesKcal * scale,
      carbsG: candidate.carbsG * scale,
      fatG: candidate.fatG * scale,
      servings: scale,
      pricePerServingCents:
        candidate.pricePerServingCents === null
          ? null
          : Math.round(candidate.pricePerServingCents * scale),
      ingredients: candidate.ingredients.map((ing) => ({
        ...ing,
        amount: ing.amount * (scale / candidate.servings),
        metricAmount: ing.metricAmount * (scale / candidate.servings),
      })),
    };
    return {
      ...scaledCandidate,
      // scaledCandidate.ingredients, not candidate.ingredients -- the
      // pantry check must compare against what this slot would actually
      // use (already scaled a few lines above), not the recipe's raw
      // native-batch amount. Previously always used the unscaled amount
      // since the deduction was purely boolean and didn't care; now that
      // coverage/depletion is quantity-aware, using the wrong amount here
      // would misjudge whether a scarce pantry item actually covers this
      // specific slot.
      score: score - pantryOverlapDeduction(scaledCandidate.ingredients, pantryTracker),
      budgetCompliant:
        !budgetAware ||
        scaledCandidate.pricePerServingCents === null ||
        scaledCandidate.pricePerServingCents <= budgetLimitCents!,
      actualTier: classifyTier(scaledCandidate, target),
      isFallbackOfLastResort: false,
      scaleFactor: scale,
    };
  });

  if (!budgetAware) {
    return sortCandidates(scored, budgetAware);
  }

  const compliant = scored.filter((c) => c.budgetCompliant);
  const nonCompliant = scored.filter((c) => !c.budgetCompliant);

  if (compliant.length > 0) {
    return [
      ...sortCandidates(compliant, budgetAware),
      ...sortCandidates(nonCompliant, budgetAware),
    ];
  }

  // None budget-compliant: this branch's own comment always said "fall
  // back to the single cheapest MACRO-MATCHING candidate," but the
  // implementation sorted by price alone with no macro consideration at
  // all -- a real bug relative to its own stated intent, found while
  // investigating audit round 2's Pro+budget fat-overshoot finding (all
  // 3 tested budget profiles showed +16-26% fat deviation regardless of
  // tightness). Live-confirmed root cause: at a tight enough budget,
  // compliant.length is often 0 (even the loosest tested budget, $60/wk,
  // had just 1/60 real compliant lunch candidates), so THIS branch -- not
  // the fat-weighting in macroDeviationScore -- was silently picking
  // whichever candidate happened to be cheapest, regardless of how badly
  // it missed on protein/calories/carbs/fat. One real cached dinner pool:
  // a 74c candidate scoring 1.069 (bad fit) was picked over an 80c
  // candidate scoring 0.076 (near-perfect) -- six cents costing a 14x
  // worse fit. Reuses sortCandidates (score-primary, price-as-tiebreak --
  // the exact logic the compliant branch above already uses) so this
  // fallback still leans toward affordability on a genuine tie, but never
  // sacrifices a meaningfully better macro fit to save a few cents.
  const sorted = sortCandidates(scored, budgetAware);
  if (sorted.length === 0) return [];
  const [best, ...others] = sorted;
  return [{ ...best, isFallbackOfLastResort: true }, ...others];
}

function sortCandidates(candidates: RankedCandidate[], budgetAware: boolean): RankedCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (budgetAware) {
      const priceA = a.pricePerServingCents ?? Infinity;
      const priceB = b.pricePerServingCents ?? Infinity;
      if (priceA !== priceB) return priceA - priceB;
    }
    return b.aggregateLikes - a.aggregateLikes;
  });
}
