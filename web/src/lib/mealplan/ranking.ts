// Epic E2 (F3) — deterministic candidate ranking (OQ2/OQ7). No LLM: this is
// a plain weighted-deviation score, budget-first ordering for Pro, and a
// cheapest-macro-match fallback when no candidate is budget-compliant.

import { classifyTier, type ToleranceTier } from "./tolerance";

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
export interface PantryItem {
  name: string;
  spoonacularIngredientId: number | null;
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

export function macroDeviationScore(
  candidate: { proteinG: number; caloriesKcal: number; carbsG: number; fatG: number },
  target: { proteinG: number; calories: number; carbsG: number; fatG: number },
): number {
  const proteinDeviation =
    (Math.abs(candidate.proteinG - target.proteinG) / target.proteinG) * 2;
  const caloriesDeviation =
    Math.abs(candidate.caloriesKcal - target.calories) / target.calories;
  const carbsDeviation =
    (Math.abs(candidate.carbsG - target.carbsG) / target.carbsG) * CARB_FAT_WEIGHT;
  const fatDeviation = (Math.abs(candidate.fatG - target.fatG) / target.fatG) * CARB_FAT_WEIGHT;
  return proteinDeviation + caloriesDeviation + carbsDeviation + fatDeviation;
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

function pantryOverlapDeduction(
  candidateIngredients: CandidateIngredient[],
  pantryItems: PantryItem[],
): number {
  if (pantryItems.length === 0 || candidateIngredients.length === 0) return 0;

  let matched = 0;
  for (const item of pantryItems) {
    const isMatch =
      item.spoonacularIngredientId !== null
        ? (ing: CandidateIngredient) => ing.id === item.spoonacularIngredientId
        : (ing: CandidateIngredient) => {
            const a = ing.name.toLowerCase();
            const b = item.name.toLowerCase();
            return a.includes(b) || b.includes(a);
          };
    if (candidateIngredients.some(isMatch)) matched++;
  }
  return Math.min(matched * PANTRY_OVERLAP_WEIGHT, MAX_PANTRY_OVERLAP_DEDUCTION);
}

export interface RankCandidatesOptions {
  tier: "free" | "pro";
  budgetPerMealUsd: number | null;
  pantryItems?: PantryItem[];
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
  const pantryItems = opts.pantryItems ?? [];

  const scored = candidates.map((candidate) => ({
    ...candidate,
    score:
      macroDeviationScore(candidate, target) -
      pantryOverlapDeduction(candidate.ingredients, pantryItems),
    budgetCompliant:
      !budgetAware ||
      candidate.pricePerServingCents === null ||
      candidate.pricePerServingCents <= budgetLimitCents!,
    actualTier: classifyTier(candidate, target),
    isFallbackOfLastResort: false,
  }));

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
