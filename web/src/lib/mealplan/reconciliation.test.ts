import { describe, it, expect } from "vitest";
import {
  toleranceBand,
  sumActuals,
  outsideMacros,
  macroGapDirections,
  isWithinBand,
  dominantIncreaseGap,
  pickSlackSlots,
  nudgedBounds,
  weeklyAccuracyTier,
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
      scaleFactor: 1,
      ...overrides,
    },
  };
}

const weeklyTarget = { calories: 14000, proteinG: 1400, carbsG: 1400, fatG: 500 };

describe("toleranceBand", () => {
  it("is +/-5% of the weekly target", () => {
    const band = toleranceBand(weeklyTarget);
    expect(band.calories).toEqual({ min: 13300, max: 14700 });
  });

  it("still defaults to +/-5% when no pct is passed (regression guard for the optional param)", () => {
    const band = toleranceBand(weeklyTarget);
    expect(band.proteinG).toEqual({ min: 1330, max: 1470 });
    expect(band.carbsG).toEqual({ min: 1330, max: 1470 });
    expect(band.fatG).toEqual({ min: 475, max: 525 });
  });

  it("uses an explicit pct override instead of the default when passed (Phase 2 addon-at-selection uses p10/0.1)", () => {
    const band = toleranceBand(weeklyTarget, 0.1);
    expect(band.calories.min).toBeCloseTo(12600, 5);
    expect(band.calories.max).toBeCloseTo(15400, 5);
  });
});

describe("outsideMacros / macroGapDirections", () => {
  it("reports nothing out of band when actuals match target", () => {
    const band = toleranceBand(weeklyTarget);
    expect(outsideMacros(weeklyTarget, band)).toEqual([]);
    expect(macroGapDirections(weeklyTarget, band)).toEqual([]);
  });

  it("detects a too-high macro as 'decrease' and a too-low macro as 'increase'", () => {
    const band = toleranceBand(weeklyTarget);
    const actual = { ...weeklyTarget, calories: 16000, proteinG: 1000 };
    const gaps = macroGapDirections(actual, band);
    expect(gaps).toContainEqual(expect.objectContaining({ macro: "calories", direction: "decrease" }));
    expect(gaps).toContainEqual(expect.objectContaining({ macro: "proteinG", direction: "increase" }));
  });
});

describe("isWithinBand", () => {
  it("is true when every macro is within band", () => {
    const band = toleranceBand(weeklyTarget);
    expect(isWithinBand(weeklyTarget, band)).toBe(true);
  });

  it("is false when any macro is outside band, at any granularity (daily or weekly)", () => {
    const dailyTarget = { calories: 2000, proteinG: 200, carbsG: 200, fatG: 70 };
    const band = toleranceBand(dailyTarget);
    expect(isWithinBand({ ...dailyTarget, carbsG: 150 }, band)).toBe(false);
  });
});

describe("weeklyAccuracyTier", () => {
  it("is on_target within 5% on every macro", () => {
    expect(weeklyAccuracyTier({ ...weeklyTarget, calories: weeklyTarget.calories * 1.03 }, weeklyTarget)).toBe(
      "on_target",
    );
  });

  it("is close when the worst macro misses by 5-15%, even if a narrow daily band would reject it", () => {
    expect(weeklyAccuracyTier({ ...weeklyTarget, calories: weeklyTarget.calories * 0.997 }, weeklyTarget)).toBe(
      "on_target",
    );
    expect(weeklyAccuracyTier({ ...weeklyTarget, proteinG: weeklyTarget.proteinG * 0.9 }, weeklyTarget)).toBe(
      "close",
    );
  });

  it("is off_target when the worst macro misses by more than 15%, e.g. a corpus-scarcity collapse", () => {
    expect(weeklyAccuracyTier({ ...weeklyTarget, calories: weeklyTarget.calories * 0.172 }, weeklyTarget)).toBe(
      "off_target",
    );
  });

  it("grades by the single worst macro, not an average", () => {
    const actual = { ...weeklyTarget, calories: weeklyTarget.calories * 1.01, fatG: weeklyTarget.fatG * 1.4 };
    expect(weeklyAccuracyTier(actual, weeklyTarget)).toBe("off_target");
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
  const perMealValue = { calories: 500, proteinG: 40, carbsG: 40, fatG: 15 };
  // Same target for all 5 types — these tests exercise slack scoring
  // generically, not the real per-meal-type split (see targets.test.ts for
  // that).
  const mealTypeTargets = {
    breakfast: perMealValue,
    lunch: perMealValue,
    dinner: perMealValue,
    snack1: perMealValue,
    snack2: perMealValue,
  };

  it("returns nothing when there are no gaps", () => {
    const claimed = [claimedSlot(1, 0)];
    expect(pickSlackSlots(claimed, mealTypeTargets, [])).toEqual([]);
  });

  it("prefers slots already above target when the weekly total needs to decrease", () => {
    const high = claimedSlot(1, 0, { caloriesKcal: 700 }); // well above per-meal target
    const low = claimedSlot(2, 1, { caloriesKcal: 300 }); // below per-meal target
    const gaps = [{ macro: "calories" as const, direction: "decrease" as const, overshootPct: 0.1 }];
    const picked = pickSlackSlots([high, low], mealTypeTargets, gaps, 1);
    expect(picked).toEqual([high.slotId]);
  });

  it("prefers slots already below target when the weekly total needs to increase", () => {
    const high = claimedSlot(1, 0, { caloriesKcal: 700 });
    const low = claimedSlot(2, 1, { caloriesKcal: 300 });
    const gaps = [{ macro: "calories" as const, direction: "increase" as const, overshootPct: 0.1 }];
    const picked = pickSlackSlots([high, low], mealTypeTargets, gaps, 1);
    expect(picked).toEqual([low.slotId]);
  });

  it("caps the result at max slots", () => {
    const claimed = allSlotIds().map((_, i) => claimedSlot(i + 1, i, { caloriesKcal: 500 + i * 10 }));
    const gaps = [{ macro: "calories" as const, direction: "decrease" as const, overshootPct: 0.1 }];
    expect(pickSlackSlots(claimed, mealTypeTargets, gaps, 3)).toHaveLength(3);
  });

  it("scores each slot against its OWN meal type's target, not a shared one", () => {
    // breakfast target is much lower than lunch's — a breakfast slot at
    // 400 cal is actually ABOVE its own (300) target, while an
    // identical-calorie lunch slot is BELOW its own (700) target.
    const differentTargets = {
      breakfast: { calories: 300, proteinG: 20, carbsG: 30, fatG: 10 },
      lunch: { calories: 700, proteinG: 50, carbsG: 70, fatG: 20 },
      dinner: { calories: 700, proteinG: 50, carbsG: 70, fatG: 20 },
      snack1: { calories: 700, proteinG: 50, carbsG: 70, fatG: 20 },
      snack2: { calories: 700, proteinG: 50, carbsG: 70, fatG: 20 },
    };
    const breakfastSlot = claimedSlot(1, 0, { caloriesKcal: 400 }); // slotId index 0 = breakfast
    const lunchSlot = claimedSlot(2, 1, { caloriesKcal: 400 }); // slotId index 1 = lunch
    const gaps = [{ macro: "calories" as const, direction: "decrease" as const, overshootPct: 0.1 }];
    // "decrease" gap prefers slots ABOVE their own target — only the
    // breakfast slot qualifies once each is judged against its own target.
    const picked = pickSlackSlots([breakfastSlot, lunchSlot], differentTargets, gaps, 1);
    expect(picked).toEqual([breakfastSlot.slotId]);
  });
});

describe("nudgedBounds", () => {
  const perMeal = { proteinG: 40, calories: 500, carbsG: 50, fatG: 20 };
  const allIncrease = [
    { macro: "proteinG" as const, direction: "increase" as const, overshootPct: 0.1 },
    { macro: "calories" as const, direction: "increase" as const, overshootPct: 0.1 },
    { macro: "carbsG" as const, direction: "increase" as const, overshootPct: 0.1 },
    { macro: "fatG" as const, direction: "increase" as const, overshootPct: 0.1 },
  ];
  const allDecrease = allIncrease.map((g) => ({ ...g, direction: "decrease" as const }));

  it("widens upward when every macro's own gap says 'increase'", () => {
    const bounds = nudgedBounds(perMeal, allIncrease, 0.15);
    expect(bounds.minProtein).toBe(40);
    expect(bounds.maxProtein).toBeCloseTo(46, 5);
    expect(bounds.minCalories).toBe(500);
    expect(bounds.maxCalories).toBeCloseTo(575, 5);
    expect(bounds.minCarbs).toBe(50);
    expect(bounds.maxCarbs).toBeCloseTo(57.5, 5);
    expect(bounds.minFat).toBe(20);
    expect(bounds.maxFat).toBeCloseTo(23, 5);
  });

  it("widens downward when every macro's own gap says 'decrease'", () => {
    const bounds = nudgedBounds(perMeal, allDecrease, 0.15);
    expect(bounds.maxProtein).toBe(40);
    expect(bounds.minProtein).toBeCloseTo(34, 5);
    expect(bounds.maxCarbs).toBe(50);
    expect(bounds.minCarbs).toBeCloseTo(42.5, 5);
    expect(bounds.maxFat).toBe(20);
    expect(bounds.minFat).toBeCloseTo(17, 5);
  });

  // The actual regression this fix is for (live-confirmed 2026-07-27): carbs
  // under target and fat over target AT THE SAME TIME used to both get
  // nudged in whichever ONE direction had the biggest raw overshoot --
  // e.g. a carb-driven "increase" call also searched for MORE fat, undoing
  // itself. Each macro must now move only in its OWN gap's direction.
  it("nudges each macro independently when their gap directions disagree", () => {
    const mixedGaps = [
      { macro: "carbsG" as const, direction: "increase" as const, overshootPct: 0.19 },
      { macro: "fatG" as const, direction: "decrease" as const, overshootPct: 0.1 },
    ];
    const bounds = nudgedBounds(perMeal, mixedGaps, 0.15);
    // carbs: nudged UP, same shape as the all-increase case.
    expect(bounds.minCarbs).toBe(50);
    expect(bounds.maxCarbs).toBeCloseTo(57.5, 5);
    // fat: nudged DOWN, same shape as the all-decrease case -- NOT dragged
    // up just because carbs needed to increase.
    expect(bounds.maxFat).toBe(20);
    expect(bounds.minFat).toBeCloseTo(17, 5);
    // protein/calories have no gap at all -- neutral +/-5% band around
    // their own target, not pushed toward either carbs' or fat's direction.
    expect(bounds.minProtein).toBeCloseTo(38, 5);
    expect(bounds.maxProtein).toBeCloseTo(42, 5);
    expect(bounds.minCalories).toBeCloseTo(475, 5);
    expect(bounds.maxCalories).toBeCloseTo(525, 5);
  });

  it("gives every macro a neutral +/-5% band when there are no gaps at all", () => {
    const bounds = nudgedBounds(perMeal, []);
    expect(bounds.minProtein).toBeCloseTo(38, 5);
    expect(bounds.maxProtein).toBeCloseTo(42, 5);
    expect(bounds.minCarbs).toBeCloseTo(47.5, 5);
    expect(bounds.maxCarbs).toBeCloseTo(52.5, 5);
  });
});

describe("sumActuals", () => {
  it("sums per-serving macros across all claimed slots", () => {
    const claimed = [claimedSlot(1, 0, { proteinG: 10, caloriesKcal: 100, carbsG: 5, fatG: 2 }), claimedSlot(2, 1, { proteinG: 20, caloriesKcal: 200, carbsG: 10, fatG: 4 })];
    expect(sumActuals(claimed)).toEqual({ calories: 300, proteinG: 30, carbsG: 15, fatG: 6 });
  });
});
