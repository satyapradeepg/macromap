// Diagnostic-only detection pass for the initial-pass pantry-depletion
// blind spot (see pantryRemaining.ts's Phase 1 header comment): the 21-slot
// recipe fan-out ranks every slot from ONE frozen pantry snapshot
// concurrently, then claims and commits depletion only afterward, so no
// slot's scoring can see what an earlier slot in the same pass already
// used. The only real-world symptom found so far (a pantry pool's
// remainingBase going negative for greek yogurt) was confirmed to be pure
// bookkeeping, not a changed recommendation -- there was no evidence a
// user ever actually got a worse recipe pick because of this gap.
//
// This module answers that open question with real data instead of
// guessing again: for each already-claimed slot, re-rank that SAME slot's
// already-fetched candidate pool against a LIVE pantry tracker (cloned,
// never the real one) that has incrementally committed every REAL claim
// before it, in the same allSlotIds() order -- i.e. "if this slot's
// scoring could see exactly what actually got used by earlier slots, would
// it have picked something different?" Every real claim (not the
// simulated pick) is what gets committed at each step, so divergence at
// slot N is measured in isolation against ground truth, not against a
// compounding hypothetical alternate plan.
//
// Fully side-effect-free and zero marginal cost: reuses candidate data
// already fetched for the real pass (no new Spoonacular/Anthropic calls),
// operates on a cloned tracker (never mutates rankOpts.pantryTracker), and
// is wrapped in a try/catch by its caller so a bug here can never affect a
// real generation. Only logs when at least one slot actually diverges --
// see orchestrate.ts's call site for the log format. Intended to run on
// real production generations to accumulate real evidence over time,
// exactly the "detect whether it matters before restructuring" step the
// original queue item asked for.

import type { MealSlotId, MealType } from "./targets";
import { slotKey } from "./targets";
import { rankCandidates, type RankedCandidate, type RankCandidatesOptions } from "./ranking";
import type { SlotCascadeResult } from "./cascade";
import { commitPantryConsumption, type PantryRemainingTracker } from "./pantryRemaining";

export interface DepletionDivergence {
  slotKey: string;
  actualCandidateId: number;
  actualScore: number;
  simulatedCandidateId: number;
  simulatedScore: number;
}

// Shallow clone is enough: remainingBase (the only field commit/release
// ever mutate) is a plain number, so copying each pool object gives the
// simulation its own independent counters while safely sharing every
// other (never-mutated) field -- item, category, matchedIngredientNames,
// unitConversionRates.
function cloneTracker(tracker: PantryRemainingTracker): PantryRemainingTracker {
  return { pools: tracker.pools.map((pool) => ({ ...pool })) };
}

export function auditDepletionBlindSpot(
  recipeSlotIds: MealSlotId[],
  cascades: SlotCascadeResult[],
  targetsByMealType: Record<MealType, { proteinG: number; calories: number; carbsG: number; fatG: number }>,
  claimedBySlotKey: Map<string, RankedCandidate>,
  startingTracker: PantryRemainingTracker,
  rankOpts: Pick<RankCandidatesOptions, "tier" | "budgetPerMealUsd">,
): DepletionDivergence[] {
  const tracker = cloneTracker(startingTracker);
  const claimedIds = new Set<number>();
  const divergences: DepletionDivergence[] = [];

  for (let i = 0; i < recipeSlotIds.length; i++) {
    const slotId = recipeSlotIds[i];
    const key = slotKey(slotId);
    const actual = claimedBySlotKey.get(key);
    if (!actual) continue; // blocked/exhausted in the real pass -- nothing to compare or commit

    const target = targetsByMealType[slotId.mealType];
    const ranked = rankCandidates(cascades[i].rankedCandidates, target, { ...rankOpts, pantryTracker: tracker });
    const simulatedPick = ranked.find((c) => !claimedIds.has(c.id));

    if (simulatedPick && simulatedPick.id !== actual.id) {
      divergences.push({
        slotKey: key,
        actualCandidateId: actual.id,
        actualScore: actual.score,
        simulatedCandidateId: simulatedPick.id,
        simulatedScore: simulatedPick.score,
      });
    }

    // Commit what ACTUALLY happened, not the simulated pick -- this
    // measures "would THIS slot alone have scored differently," holding
    // everything before it fixed to reality, not "what would a fully
    // alternate plan look like" (which would compound drift slot over
    // slot and make results much harder to interpret).
    claimedIds.add(actual.id);
    commitPantryConsumption(tracker, actual.ingredients);
  }

  return divergences;
}
