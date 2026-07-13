// Epic E2 (F3) — OQ2 macro tolerance retrieval for a single meal slot. Pure
// given an injected fetcher: never touches `fetch`/Supabase directly, so
// it's testable with a fake FetchCandidatesFn returning canned arrays.

import { boundsForTier, type MacroBounds, type ToleranceTier } from "./tolerance";
import { rankCandidates, type RankCandidatesOptions, type RankedCandidate, type RecipeCandidate } from "./ranking";

// Fetches via Spoonacular's own minProtein/maxProtein/minCalories/maxCalories
// filter (OQ2) — see spoonacular.ts for why this is the retrieval mechanism,
// not a broad unfiltered fetch matched locally.
export type FetchCandidatesFn = (
  bounds: MacroBounds,
  tier: ToleranceTier,
) => Promise<RecipeCandidate[]>;

export interface SlotCascadeResult {
  rankedCandidates: RankedCandidate[]; // [] when blocked; each carries its own real actualTier
  blocked: boolean;
  blockingHint: string | null;
}

// Always fetches at the WIDEST tier (p30) — a strict superset of p10/p20's
// real matches — rather than only widening when the tightest tier is
// completely empty. Verified live: for a real profile, this roughly
// quadrupled the carb/fat-compliant hit rate (6/40 vs 1/25) versus only
// widening when p10 is completely empty. This can't hurt protein/calorie
// precision — rankCandidates' score-based ordering means a p30-only
// candidate can never outrank a genuine p10 match, it only adds more to
// choose from. Each returned candidate carries its own real actualTier
// (see ranking.ts), since a p30-bounded fetch mixes candidates of
// different true qualities — there's no single tier label for the whole
// result anymore.
export async function runCascadeForSlot(
  target: { proteinG: number; calories: number; carbsG: number; fatG: number },
  fetchCandidates: FetchCandidatesFn,
  rankOpts: RankCandidatesOptions,
): Promise<SlotCascadeResult> {
  const widestBounds = boundsForTier(target, "p30");
  const candidates = await fetchCandidates(widestBounds, "p30");
  if (candidates.length === 0) {
    return { rankedCandidates: [], blocked: true, blockingHint: blockingHintFor(target) };
  }

  const ranked = rankCandidates(candidates, target, rankOpts);
  if (ranked.length === 0) {
    return { rankedCandidates: [], blocked: true, blockingHint: blockingHintFor(target) };
  }

  return { rankedCandidates: ranked, blocked: false, blockingHint: null };
}

// "closest match — slightly outside your targets" for a candidate whose
// real tier is p20/p30, or the budget-fallback label — null for a p10
// candidate with no budget compromise. Checks budgetCompliant (not just
// isFallbackOfLastResort) so a non-compliant candidate claimed after
// stepping down through collisions (ranking.ts demotes rather than drops
// non-compliant picks) still gets flagged, not just the sole fallback pick.
export function matchLabelFor(
  tier: ToleranceTier,
  candidate: RankedCandidate,
  target: { proteinG: number; calories: number },
): string | null {
  if (!candidate.budgetCompliant && candidate.pricePerServingCents !== null) {
    const overCents = candidate.pricePerServingCents; // caller compares to budget if it wants a delta
    return `Closest to your budget — $${(overCents / 100).toFixed(2)}/serving`;
  }
  if (tier !== "p10") {
    const proteinDelta = Math.round(candidate.proteinG - target.proteinG);
    const caloriesDelta = Math.round(candidate.caloriesKcal - target.calories);
    return `Closest match — slightly outside your targets (${formatDelta(proteinDelta)}g protein, ${formatDelta(caloriesDelta)} cal)`;
  }
  return null;
}

function formatDelta(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function blockingHintFor(target: { proteinG: number; calories: number }): string {
  return `Your protein target for this meal is very high (${Math.round(target.proteinG)}g) — try reducing it by 10g and regenerating.`;
}
