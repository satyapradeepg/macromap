// Epic E2 (F3) — OQ7 claim-resolution: fixed-order greedy claiming across
// the 21 independently-fetched slot cascades. Pure/synchronous: does not
// re-query itself (the caller re-queries exhaustedSlots, spending the
// shared RetryBudget, see retryBudget.ts).

import type { MealSlotId } from "./targets";
import type { RankedCandidate } from "./ranking";
import type { SlotCascadeResult } from "./cascade";
import type { ToleranceTier } from "./tolerance";
import { allSlotIds, slotKey } from "./targets";

export interface SlotFetchResult {
  slotId: MealSlotId;
  cascade: SlotCascadeResult;
}

export interface ClaimedSlot {
  slotId: MealSlotId;
  candidate: RankedCandidate;
  tier: ToleranceTier;
}

export interface ClaimResolutionResult {
  claimed: ClaimedSlot[];
  blockedSlots: MealSlotId[]; // cascade came back blocked for this slot
  exhaustedSlots: MealSlotId[]; // whole ranked list already claimed by earlier slots
}

// Walks allSlotIds() order (Day1 Breakfast .. Day7 Dinner). Each slot
// greedily claims its own highest-ranked candidate whose id hasn't already
// been claimed by an earlier slot in this walk; steps down its own list on
// collision. Budget-awareness already lives in the list's ordering
// (ranking.ts), so stepping down never reintroduces a resolved budget miss.
export function resolveClaims(results: SlotFetchResult[]): ClaimResolutionResult {
  const bySlot = new Map(results.map((r) => [slotKey(r.slotId), r]));
  const claimedRecipeIds = new Set<number>();
  const claimed: ClaimedSlot[] = [];
  const blockedSlots: MealSlotId[] = [];
  const exhaustedSlots: MealSlotId[] = [];

  for (const slotId of allSlotIds()) {
    const result = bySlot.get(slotKey(slotId));
    if (!result) {
      // No fetch result at all for this slot — treat as exhausted so the
      // caller's retry path handles it uniformly with a genuinely-collided slot.
      exhaustedSlots.push(slotId);
      continue;
    }

    if (result.cascade.blocked) {
      blockedSlots.push(slotId);
      continue;
    }

    const pick = result.cascade.rankedCandidates.find((c) => !claimedRecipeIds.has(c.id));
    if (!pick) {
      exhaustedSlots.push(slotId);
      continue;
    }

    claimedRecipeIds.add(pick.id);
    // Real per-candidate tier (see ranking.ts's actualTier) — a p30-bounded
    // fetch mixes candidates of different true qualities, so there's no
    // single tier label for the whole cascade result anymore. Falls back
    // to "p30" only if genuinely outside all three (shouldn't happen for a
    // candidate that passed the p30-bounded fetch, but keeps the DB's
    // NOT NULL constraint satisfied either way).
    claimed.push({ slotId, candidate: pick, tier: pick.actualTier ?? "p30" });
  }

  return { claimed, blockedSlots, exhaustedSlots };
}
