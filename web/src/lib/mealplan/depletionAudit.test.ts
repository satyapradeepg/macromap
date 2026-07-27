import { describe, it, expect } from "vitest";
import { auditDepletionBlindSpot } from "./depletionAudit";
import { buildPantryRemainingTracker } from "./pantryRemaining";
import type { RankedCandidate, RecipeCandidate, PantryItem, CandidateIngredient } from "./ranking";
import type { SlotCascadeResult } from "./cascade";
import type { MealSlotId, MealType } from "./targets";

function pantryItem(overrides: Partial<PantryItem> = {}): PantryItem {
  return { name: "irrelevant name", spoonacularIngredientId: null, amount: null, unit: null, ...overrides };
}

function ing(overrides: Partial<CandidateIngredient> = {}): CandidateIngredient {
  return { id: 1, name: "yogurt", amount: 200, unit: "g", metricAmount: 200, metricUnit: "g", ...overrides };
}

function candidate(overrides: Partial<RecipeCandidate> = {}): RecipeCandidate {
  return {
    id: 1,
    title: "Test Recipe",
    imageUrl: null,
    servings: 1,
    proteinG: 100,
    caloriesKcal: 500,
    carbsG: 50,
    fatG: 20,
    pricePerServingCents: 300,
    aggregateLikes: 10,
    ingredients: [],
    ...overrides,
  };
}

function ranked(overrides: Partial<RankedCandidate>): RankedCandidate {
  return {
    ...candidate(overrides),
    score: 0,
    budgetCompliant: true,
    actualTier: "p10",
    isFallbackOfLastResort: false,
    scaleFactor: 1,
    ...overrides,
  };
}

function cascade(rankedCandidates: RecipeCandidate[]): SlotCascadeResult {
  return { rankedCandidates: rankedCandidates as RankedCandidate[], blocked: false, blockingHint: null };
}

const TARGET = { proteinG: 100, calories: 500, carbsG: 50, fatG: 20 };
const targetsByMealType: Record<MealType, typeof TARGET> = {
  breakfast: TARGET,
  lunch: TARGET,
  dinner: TARGET,
  snack1: TARGET,
  snack2: TARGET,
};
const rankOpts = { tier: "free" as const, budgetPerMealUsd: null };

describe("auditDepletionBlindSpot", () => {
  it("reports no divergence when no pantry items are involved at all", () => {
    const slots: MealSlotId[] = [{ dayIndex: 0, mealType: "breakfast" }];
    const c1 = ranked({ id: 1, score: 0 });
    const claimedBySlotKey = new Map([["0-breakfast", c1]]);
    const tracker = buildPantryRemainingTracker([], new Map());

    const divergences = auditDepletionBlindSpot(
      slots,
      [cascade([c1])],
      targetsByMealType,
      claimedBySlotKey,
      tracker,
      rankOpts,
    );

    expect(divergences).toEqual([]);
  });

  it("skips a blocked/exhausted slot (no actual claim) without crashing or committing anything", () => {
    const slots: MealSlotId[] = [{ dayIndex: 0, mealType: "breakfast" }];
    const claimedBySlotKey = new Map<string, RankedCandidate>(); // nothing claimed
    const tracker = buildPantryRemainingTracker([pantryItem({ amount: 200, unit: "g" })], new Map());

    const divergences = auditDepletionBlindSpot(
      slots,
      [cascade([ranked({ id: 1 })])],
      targetsByMealType,
      claimedBySlotKey,
      tracker,
      rankOpts,
    );

    expect(divergences).toEqual([]);
  });

  it("detects a real divergence: a later slot's pick would change once an earlier slot's real pantry use is visible", () => {
    // Two pantry items, both fully consumed by "the yogurt+spinach recipe".
    // A slightly-worse macro fit (id 1/3) still wins its OWN slot under a
    // full pantry (2-ingredient match bonus outweighs the macro gap), but
    // once a real earlier claim has already used both up, the same recipe
    // no longer gets that bonus -- the plain, better-macro-fit recipe
    // (id 2/4) should win instead under live depletion visibility.
    const pantryItems = [
      pantryItem({ name: "yogurt", amount: 200, unit: "g" }),
      pantryItem({ name: "spinach", amount: 100, unit: "g" }),
    ];
    const tracker = buildPantryRemainingTracker(pantryItems, new Map());

    const pantryIngredients = [
      ing({ id: 101, name: "yogurt", amount: 200, unit: "g", metricAmount: 200, metricUnit: "g" }),
      ing({ id: 102, name: "spinach", amount: 100, unit: "g", metricAmount: 100, metricUnit: "g" }),
    ];

    // Raw (pre-pantry-bonus) score ~0.03 (slightly off-target protein).
    const usesPantry = (id: number) => candidate({ id, proteinG: 98.5, ingredients: pantryIngredients });
    // Raw score ~0.005 (closer to target), no pantry ingredients at all.
    const plain = (id: number) => candidate({ id, proteinG: 99.75, ingredients: [] });

    const slots: MealSlotId[] = [
      { dayIndex: 0, mealType: "breakfast" },
      { dayIndex: 1, mealType: "breakfast" },
    ];
    const cascades = [cascade([usesPantry(1), plain(2)]), cascade([usesPantry(3), plain(4)])];

    // "Actual" claims: both slots picked the pantry-using recipe, matching
    // what a real generation would do -- every slot ranks from the SAME
    // frozen snapshot, so slot 2 (day 1) has no way to know slot 1 (day 0)
    // already used up the pantry.
    const claimedBySlotKey = new Map([
      ["0-breakfast", ranked({ id: 1, ingredients: pantryIngredients, score: -0.01 })],
      ["1-breakfast", ranked({ id: 3, ingredients: pantryIngredients, score: -0.01 })],
    ]);

    const divergences = auditDepletionBlindSpot(
      slots,
      cascades,
      targetsByMealType,
      claimedBySlotKey,
      tracker,
      rankOpts,
    );

    // Slot 1 (day 0) sees a still-full pantry (nothing committed yet) --
    // its simulated pick matches what actually happened, no divergence.
    // Slot 2 (day 1) sees the pantry already fully depleted by slot 1's
    // REAL consumption -- its simulated pick should flip to the plain
    // recipe (id 4), diverging from what actually got claimed (id 3).
    expect(divergences).toHaveLength(1);
    expect(divergences[0].slotKey).toBe("1-breakfast");
    expect(divergences[0].actualCandidateId).toBe(3);
    expect(divergences[0].simulatedCandidateId).toBe(4);

    // The first slot processed (day 0) sees a still-full pantry -- nothing
    // committed yet -- so its own simulated pick can never diverge from
    // reality. Confirmed implicitly above (only 1 divergence, not 2), but
    // asserted explicitly here since it's the exact "first slot in a pass
    // never diverges" property the real blind spot depends on.
    expect(divergences.some((d) => d.slotKey === "0-breakfast")).toBe(false);
  });
});
