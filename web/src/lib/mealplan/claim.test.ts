import { describe, it, expect } from "vitest";
import { resolveClaims, type SlotFetchResult } from "./claim";
import type { RankedCandidate } from "./ranking";
import { allSlotIds, MEALS_PER_WEEK } from "./targets";

function ranked(id: number, overrides: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    id,
    title: `Recipe ${id}`,
    imageUrl: null,
    servings: 1,
    proteinG: 40,
    caloriesKcal: 500,
    carbsG: 40,
    fatG: 15,
    pricePerServingCents: null,
    aggregateLikes: 0,
    ingredients: [],
    score: 0,
    budgetCompliant: true,
    actualTier: "p10",
    isFallbackOfLastResort: false,
    scaleFactor: 1,
    ...overrides,
  };
}

const slots = allSlotIds();

function cascadeResult(candidates: RankedCandidate[]): SlotFetchResult["cascade"] {
  return { rankedCandidates: candidates, blocked: false, blockingHint: null };
}

describe("resolveClaims", () => {
  it("claims the top candidate for each slot when there's no collision", () => {
    const results: SlotFetchResult[] = slots.map((slotId, i) => ({
      slotId,
      cascade: cascadeResult([ranked(i + 1)]),
    }));
    const { claimed, blockedSlots, exhaustedSlots } = resolveClaims(results);
    expect(claimed).toHaveLength(MEALS_PER_WEEK);
    expect(blockedSlots).toHaveLength(0);
    expect(exhaustedSlots).toHaveLength(0);
    expect(new Set(claimed.map((c) => c.candidate.id)).size).toBe(MEALS_PER_WEEK); // all unique
  });

  it("steps down to the next-ranked candidate on collision", () => {
    // Both slots rank recipe 1 first; slot A comes first in the fixed walk
    // order and should claim it, slot B should step down to recipe 2.
    const results: SlotFetchResult[] = [
      { slotId: slots[0], cascade: cascadeResult([ranked(1), ranked(2)]) },
      { slotId: slots[1], cascade: cascadeResult([ranked(1), ranked(2)]) },
    ];
    const { claimed } = resolveClaims(results);
    expect(claimed[0].candidate.id).toBe(1);
    expect(claimed[1].candidate.id).toBe(2);
  });

  it("marks a slot exhausted when its whole ranked list is already claimed", () => {
    const results: SlotFetchResult[] = slots.map((slotId, i) => {
      if (i === 0) return { slotId, cascade: cascadeResult([ranked(1)]) };
      if (i === 1) return { slotId, cascade: cascadeResult([ranked(1)]) }; // only option, already taken
      return { slotId, cascade: cascadeResult([ranked(i + 100)]) }; // unrelated, unique candidates
    });
    const { claimed, exhaustedSlots } = resolveClaims(results);
    expect(claimed).toHaveLength(MEALS_PER_WEEK - 1); // every slot except slots[1]
    expect(exhaustedSlots).toEqual([slots[1]]);
  });

  it("reports blocked slots separately from exhausted ones", () => {
    const results: SlotFetchResult[] = slots.map((slotId, i) => {
      if (i === 0) {
        return {
          slotId,
          cascade: { rankedCandidates: [], blocked: true, blockingHint: "too high" },
        };
      }
      return { slotId, cascade: cascadeResult([ranked(i + 100)]) };
    });
    const { claimed, blockedSlots, exhaustedSlots } = resolveClaims(results);
    expect(claimed).toHaveLength(MEALS_PER_WEEK - 1);
    expect(blockedSlots).toEqual([slots[0]]);
    expect(exhaustedSlots).toHaveLength(0);
  });

  it("skips slots with no fetch result entirely, not a crash — a real caller passes a subset (e.g. recipe-mechanism slots only, snacks resolved separately)", () => {
    const { claimed, blockedSlots, exhaustedSlots } = resolveClaims([]);
    expect(claimed).toHaveLength(0);
    expect(blockedSlots).toHaveLength(0);
    expect(exhaustedSlots).toHaveLength(0);
  });

  it("resolves only the slots actually passed in, leaving the rest untouched", () => {
    const results: SlotFetchResult[] = [slots[0], slots[1]].map((slotId, i) => ({
      slotId,
      cascade: cascadeResult([ranked(i + 1)]),
    }));
    const { claimed, blockedSlots, exhaustedSlots } = resolveClaims(results);
    expect(claimed.map((c) => c.slotId)).toEqual(
      expect.arrayContaining([slots[0], slots[1]]),
    );
    expect(claimed).toHaveLength(2);
    expect(blockedSlots).toHaveLength(0);
    expect(exhaustedSlots).toHaveLength(0);
  });
});
