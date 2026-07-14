import { describe, it, expect } from "vitest";
import {
  weeklyBand,
  sumActuals,
  outsideMacros,
  macroGapDirections,
  dominantDirection,
  dominantIncreaseGap,
  pickSlackSlots,
  nudgedBounds,
} from "./reconciliation";
import type { ClaimedSlot } from "./claim";
import type { RankedCandidate } from "./ranking";
import { allSlotIds } from "./targets";

function claimedSlot(id: number, index: number, overrides: Partial<RankedCandidate> = {}): ClaimedSlot {
  return {
    slotId: allSlotIds()[index],
    tier: "p10",
    candidate: {
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
      ...overrides,
    },
  };
}

const weeklyTarget = { calories: 14000, proteinG: 1400, carbsG: 1400, fatG: 500 };

describe("weeklyBand", () => {
  it("is +/-5% of the weekly target", () => {
    const band = weeklyBand(weeklyTarget);
    expect(band.calories).toEqual({ min: 13300, max: 14700 });
  });
});

describe("outsideMacros / macroGapDirections", () => {
  it("reports nothing out of band when actuals match target", () => {
    const band = weeklyBand(weeklyTarget);
    expect(outsideMacros(weeklyTarget, band)).toEqual([]);
    expect(macroGapDirections(weeklyTarget, band)).toEqual([]);
  });

  it("detects a too-high macro as 'decrease' and a too-low macro as 'increase'", () => {
    const band = weeklyBand(weeklyTarget);
    const actual = { ...weeklyTarget, calories: 16000, proteinG: 1000 };
    const gaps = macroGapDirections(actual, band);
    expect(gaps).toContainEqual(expect.objectContaining({ macro: "calories", direction: "decrease" }));
    expect(gaps).toContainEqual(expect.objectContaining({ macro: "proteinG", direction: "increase" }));
  });
});

describe("dominantDirection", () => {
  it("returns null when there are no gaps", () => {
    expect(dominantDirection([])).toBeNull();
  });

  it("picks the direction of the largest relative overshoot", () => {
    const gaps = [
      { macro: "calories" as const, direction: "decrease" as const, overshootPct: 0.02 },
      { macro: "proteinG" as const, direction: "increase" as const, overshootPct: 0.3 },
    ];
    expect(dominantDirection(gaps)).toBe("increase");
  });
});

describe("dominantIncreaseGap", () => {
  it("returns null when there are no gaps", () => {
    expect(dominantIncreaseGap([])).toBeNull();
  });

  it("returns null when every gap is 'decrease' (an add-on can't help)", () => {
    const gaps = [
      { macro: "calories" as const, direction: "decrease" as const, overshootPct: 0.2 },
      { macro: "fatG" as const, direction: "decrease" as const, overshootPct: 0.1 },
    ];
    expect(dominantIncreaseGap(gaps)).toBeNull();
  });

  it("picks the largest-overshoot 'increase' gap, ignoring 'decrease' gaps", () => {
    const gaps = [
      { macro: "fatG" as const, direction: "decrease" as const, overshootPct: 0.5 },
      { macro: "proteinG" as const, direction: "increase" as const, overshootPct: 0.1 },
      { macro: "carbsG" as const, direction: "increase" as const, overshootPct: 0.3 },
    ];
    expect(dominantIncreaseGap(gaps)).toEqual({ macro: "carbsG", direction: "increase", overshootPct: 0.3 });
  });
});

describe("pickSlackSlots", () => {
  const perMeal = { calories: 500, proteinG: 40, carbsG: 40, fatG: 15 };

  it("returns nothing when there are no gaps", () => {
    const claimed = [claimedSlot(1, 0)];
    expect(pickSlackSlots(claimed, perMeal, [])).toEqual([]);
  });

  it("prefers slots already above target when the weekly total needs to decrease", () => {
    const high = claimedSlot(1, 0, { caloriesKcal: 700 }); // well above per-meal target
    const low = claimedSlot(2, 1, { caloriesKcal: 300 }); // below per-meal target
    const gaps = [{ macro: "calories" as const, direction: "decrease" as const, overshootPct: 0.1 }];
    const picked = pickSlackSlots([high, low], perMeal, gaps, 1);
    expect(picked).toEqual([high.slotId]);
  });

  it("prefers slots already below target when the weekly total needs to increase", () => {
    const high = claimedSlot(1, 0, { caloriesKcal: 700 });
    const low = claimedSlot(2, 1, { caloriesKcal: 300 });
    const gaps = [{ macro: "calories" as const, direction: "increase" as const, overshootPct: 0.1 }];
    const picked = pickSlackSlots([high, low], perMeal, gaps, 1);
    expect(picked).toEqual([low.slotId]);
  });

  it("caps the result at max slots", () => {
    const claimed = allSlotIds().map((_, i) => claimedSlot(i + 1, i, { caloriesKcal: 500 + i * 10 }));
    const gaps = [{ macro: "calories" as const, direction: "decrease" as const, overshootPct: 0.1 }];
    expect(pickSlackSlots(claimed, perMeal, gaps, 3)).toHaveLength(3);
  });
});

describe("nudgedBounds", () => {
  const perMeal = { proteinG: 40, calories: 500, carbsG: 50, fatG: 20 };

  it("widens upward on 'increase', across all four macros", () => {
    const bounds = nudgedBounds(perMeal, "increase", 0.15);
    expect(bounds.minProtein).toBe(40);
    expect(bounds.maxProtein).toBeCloseTo(46, 5);
    expect(bounds.minCalories).toBe(500);
    expect(bounds.maxCalories).toBeCloseTo(575, 5);
    expect(bounds.minCarbs).toBe(50);
    expect(bounds.maxCarbs).toBeCloseTo(57.5, 5);
    expect(bounds.minFat).toBe(20);
    expect(bounds.maxFat).toBeCloseTo(23, 5);
  });

  it("widens downward on 'decrease', across all four macros", () => {
    const bounds = nudgedBounds(perMeal, "decrease", 0.15);
    expect(bounds.maxProtein).toBe(40);
    expect(bounds.minProtein).toBeCloseTo(34, 5);
    expect(bounds.maxCarbs).toBe(50);
    expect(bounds.minCarbs).toBeCloseTo(42.5, 5);
    expect(bounds.maxFat).toBe(20);
    expect(bounds.minFat).toBeCloseTo(17, 5);
  });
});

describe("sumActuals", () => {
  it("sums per-serving macros across all claimed slots", () => {
    const claimed = [claimedSlot(1, 0, { proteinG: 10, caloriesKcal: 100, carbsG: 5, fatG: 2 }), claimedSlot(2, 1, { proteinG: 20, caloriesKcal: 200, carbsG: 10, fatG: 4 })];
    expect(sumActuals(claimed)).toEqual({ calories: 300, proteinG: 30, carbsG: 15, fatG: 6 });
  });
});
