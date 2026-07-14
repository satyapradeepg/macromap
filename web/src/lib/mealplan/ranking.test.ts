import { describe, it, expect } from "vitest";
import {
  macroDeviationScore,
  rankCandidates,
  type PantryItem,
  type RecipeCandidate,
} from "./ranking";

function candidate(overrides: Partial<RecipeCandidate> = {}): RecipeCandidate {
  return {
    id: 1,
    title: "Test Recipe",
    imageUrl: null,
    servings: 1,
    proteinG: 40,
    caloriesKcal: 500,
    carbsG: 40,
    fatG: 15,
    pricePerServingCents: 300,
    aggregateLikes: 10,
    ingredients: [],
    ...overrides,
  };
}

// Matches candidate()'s carbsG/fatG defaults, so tests that only vary
// protein/calories get an exact carb/fat match (0 contribution to score)
// and aren't affected by the carb/fat weighting unless they say otherwise.
const target = { proteinG: 40, calories: 500, carbsG: 40, fatG: 15 };

describe("macroDeviationScore", () => {
  it("is 0 for an exact match", () => {
    const score = macroDeviationScore(
      { proteinG: 40, caloriesKcal: 500, carbsG: 40, fatG: 15 },
      target,
    );
    expect(score).toBe(0);
  });

  it("weights protein deviation 2x calories deviation", () => {
    const proteinOff = macroDeviationScore(
      { proteinG: 44, caloriesKcal: 500, carbsG: 40, fatG: 15 }, // 10% protein over
      target,
    );
    const caloriesOff = macroDeviationScore(
      { proteinG: 40, caloriesKcal: 550, carbsG: 40, fatG: 15 }, // 10% calories over
      target,
    );
    expect(proteinOff).toBeCloseTo(0.2, 5);
    expect(caloriesOff).toBeCloseTo(0.1, 5);
  });

  it("weights carbs/fat deviation at 0.5x", () => {
    const carbsOff = macroDeviationScore(
      { proteinG: 40, caloriesKcal: 500, carbsG: 44, fatG: 15 }, // 10% carbs over
      target,
    );
    const fatOff = macroDeviationScore(
      { proteinG: 40, caloriesKcal: 500, carbsG: 40, fatG: 16.5 }, // 10% fat over
      target,
    );
    expect(carbsOff).toBeCloseTo(0.05, 5); // 10% * 0.5
    expect(fatOff).toBeCloseTo(0.05, 5);
  });

  it("never lets carb/fat deviation override a meaningfully better protein/calorie match", () => {
    // Exact protein/calories but terrible carbs/fat vs. a meaningfully
    // worse protein/calorie match with perfect carbs/fat.
    const exactProteinCalories = macroDeviationScore(
      { proteinG: 40, caloriesKcal: 500, carbsG: 0, fatG: 0 },
      target,
    );
    const worseProteinCalories = macroDeviationScore(
      { proteinG: 55, caloriesKcal: 650, carbsG: 40, fatG: 15 },
      target,
    );
    expect(exactProteinCalories).toBeLessThan(worseProteinCalories);
  });
});

describe("rankCandidates", () => {
  it("free tier skips budget logic entirely, even with a budget set", () => {
    const candidates = [
      candidate({ id: 1, pricePerServingCents: 1000 }),
      candidate({ id: 2, pricePerServingCents: 100 }),
    ];
    const ranked = rankCandidates(candidates, target, { tier: "free", budgetPerMealUsd: 2 });
    expect(ranked.every((c) => c.budgetCompliant)).toBe(true);
    expect(ranked.every((c) => !c.isFallbackOfLastResort)).toBe(true);
  });

  it("pro tier with no budget set behaves like free tier", () => {
    const candidates = [candidate({ id: 1, pricePerServingCents: 1000 })];
    const ranked = rankCandidates(candidates, target, { tier: "pro", budgetPerMealUsd: null });
    expect(ranked[0].budgetCompliant).toBe(true);
  });

  it("ranks budget-compliant candidates first for pro tier, without dropping the rest", () => {
    const overBudget = candidate({ id: 1, pricePerServingCents: 1000, proteinG: 40, caloriesKcal: 500 });
    const underBudget = candidate({ id: 2, pricePerServingCents: 100, proteinG: 30, caloriesKcal: 400 }); // worse macro match
    const ranked = rankCandidates([overBudget, underBudget], target, {
      tier: "pro",
      budgetPerMealUsd: 2,
    });
    // Compliant candidate first, but the non-compliant one is demoted to
    // the back of the list, not discarded — claim-resolution needs the
    // full pool to step through on collisions across 21 slots (this was
    // the root cause of a real "only 2 of 21 meals generated" bug: with a
    // tight budget, dropping non-compliant candidates could shrink the
    // shared candidate pool down to just one or two usable entries).
    expect(ranked.map((c) => c.id)).toEqual([2, 1]);
    expect(ranked[0].budgetCompliant).toBe(true);
    expect(ranked[1].budgetCompliant).toBe(false);
  });

  it("keeps the full pool available (not just the cheapest) when none are budget-compliant", () => {
    const candidates = [
      candidate({ id: 1, pricePerServingCents: 1000 }),
      candidate({ id: 2, pricePerServingCents: 500 }),
      candidate({ id: 3, pricePerServingCents: 800 }),
    ];
    const ranked = rankCandidates(candidates, target, { tier: "pro", budgetPerMealUsd: 2 });
    expect(ranked).toHaveLength(3);
    expect(ranked[0].id).toBe(2); // cheapest of the three, flagged as the fallback of last resort
    expect(ranked[0].isFallbackOfLastResort).toBe(true);
    expect(ranked.slice(1).map((c) => c.id).sort()).toEqual([1, 3]); // rest still present for step-down
  });

  it("breaks ties by cheapest then highest aggregateLikes (budget-aware)", () => {
    const a = candidate({ id: 1, pricePerServingCents: 200, aggregateLikes: 5, proteinG: 40, caloriesKcal: 500 });
    const b = candidate({ id: 2, pricePerServingCents: 100, aggregateLikes: 5, proteinG: 40, caloriesKcal: 500 });
    const ranked = rankCandidates([a, b], target, { tier: "pro", budgetPerMealUsd: 5 });
    expect(ranked.map((c) => c.id)).toEqual([2, 1]); // cheaper wins the tie
  });

  it("breaks ties by highest aggregateLikes when not budget-aware", () => {
    const a = candidate({ id: 1, aggregateLikes: 5, proteinG: 40, caloriesKcal: 500 });
    const b = candidate({ id: 2, aggregateLikes: 50, proteinG: 40, caloriesKcal: 500 });
    const ranked = rankCandidates([a, b], target, { tier: "free", budgetPerMealUsd: null });
    expect(ranked.map((c) => c.id)).toEqual([2, 1]);
  });

  it("orders non-tied candidates by score ascending", () => {
    const close = candidate({ id: 1, proteinG: 41, caloriesKcal: 505 });
    const far = candidate({ id: 2, proteinG: 60, caloriesKcal: 700 });
    const ranked = rankCandidates([far, close], target, { tier: "free", budgetPerMealUsd: null });
    expect(ranked.map((c) => c.id)).toEqual([1, 2]);
  });

  it("returns an empty list for empty input", () => {
    expect(rankCandidates([], target, { tier: "free", budgetPerMealUsd: null })).toEqual([]);
  });

  it("attaches each candidate's real actualTier classification", () => {
    const exact = candidate({ id: 1, proteinG: 40, caloriesKcal: 500 });
    const outsideP10 = candidate({ id: 2, proteinG: 46, caloriesKcal: 580 });
    const ranked = rankCandidates([exact, outsideP10], target, { tier: "free", budgetPerMealUsd: null });
    expect(ranked.find((c) => c.id === 1)!.actualTier).toBe("p10");
    expect(ranked.find((c) => c.id === 2)!.actualTier).toBe("p20");
  });

  describe("pantry overlap (F6/F3)", () => {
    const chicken = { id: 101, name: "chicken breast", amount: 1, unit: "lb", metricAmount: 450, metricUnit: "g" };
    const rice = { id: 202, name: "white rice", amount: 1, unit: "cup", metricAmount: 190, metricUnit: "g" };

    it("prefers a candidate using pantry ingredients over an equally-good macro match without them", () => {
      const withPantry = candidate({ id: 1, ingredients: [chicken] });
      const withoutPantry = candidate({ id: 2, ingredients: [] });
      const pantryItems: PantryItem[] = [{ name: "chicken breast", spoonacularIngredientId: null }];
      const ranked = rankCandidates([withoutPantry, withPantry], target, {
        tier: "free",
        budgetPerMealUsd: null,
        pantryItems,
      });
      expect(ranked.map((c) => c.id)).toEqual([1, 2]);
    });

    it("matches by resolved spoonacularIngredientId when available", () => {
      const withPantry = candidate({ id: 1, ingredients: [chicken] });
      const withoutPantry = candidate({ id: 2, ingredients: [] });
      const pantryItems: PantryItem[] = [{ name: "some unrelated label", spoonacularIngredientId: 101 }];
      const ranked = rankCandidates([withoutPantry, withPantry], target, {
        tier: "free",
        budgetPerMealUsd: null,
        pantryItems,
      });
      expect(ranked.map((c) => c.id)).toEqual([1, 2]);
    });

    it("falls back to a loose case-insensitive name match when unresolved", () => {
      const withPantry = candidate({
        id: 1,
        ingredients: [{ ...chicken, name: "boneless skinless chicken breast" }],
      });
      const pantryItems: PantryItem[] = [{ name: "Chicken Breast", spoonacularIngredientId: null }];
      const ranked = rankCandidates([withPantry], target, {
        tier: "free",
        budgetPerMealUsd: null,
        pantryItems,
      });
      expect(ranked[0].score).toBeLessThan(macroDeviationScore(withPantry, target));
    });

    it("never lets pantry overlap override a meaningfully better macro match", () => {
      const worseMatchWithPantry = candidate({
        id: 1,
        proteinG: 60,
        caloriesKcal: 700,
        ingredients: [chicken, rice],
      });
      const betterMatchNoPantry = candidate({ id: 2, proteinG: 41, caloriesKcal: 505, ingredients: [] });
      const pantryItems: PantryItem[] = [
        { name: "chicken breast", spoonacularIngredientId: null },
        { name: "white rice", spoonacularIngredientId: null },
      ];
      const ranked = rankCandidates([worseMatchWithPantry, betterMatchNoPantry], target, {
        tier: "free",
        budgetPerMealUsd: null,
        pantryItems,
      });
      expect(ranked.map((c) => c.id)).toEqual([2, 1]);
    });

    it("is a no-op when pantryItems is omitted or empty", () => {
      const a = candidate({ id: 1, ingredients: [chicken] });
      const withoutOpt = rankCandidates([a], target, { tier: "free", budgetPerMealUsd: null });
      const withEmpty = rankCandidates([a], target, {
        tier: "free",
        budgetPerMealUsd: null,
        pantryItems: [],
      });
      expect(withoutOpt[0].score).toBe(macroDeviationScore(a, target));
      expect(withEmpty[0].score).toBe(macroDeviationScore(a, target));
    });
  });
});
