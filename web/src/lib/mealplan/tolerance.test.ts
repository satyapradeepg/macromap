import { describe, it, expect } from "vitest";
import { boundsForTier, classifyTier } from "./tolerance";

describe("boundsForTier", () => {
  const target = { proteinG: 40, calories: 500, carbsG: 50, fatG: 20 };

  it("computes +/-10% at p10, including carbs/fat", () => {
    const bounds = boundsForTier(target, "p10");
    expect(bounds.minProtein).toBeCloseTo(36, 5);
    expect(bounds.maxProtein).toBeCloseTo(44, 5);
    expect(bounds.minCalories).toBeCloseTo(450, 5);
    expect(bounds.maxCalories).toBeCloseTo(550, 5);
    expect(bounds.minCarbs).toBeCloseTo(45, 5);
    expect(bounds.maxCarbs).toBeCloseTo(55, 5);
    expect(bounds.minFat).toBeCloseTo(18, 5);
    expect(bounds.maxFat).toBeCloseTo(22, 5);
  });

  it("computes +/-30% at p30", () => {
    const bounds = boundsForTier(target, "p30");
    expect(bounds.minProtein).toBeCloseTo(28, 5);
    expect(bounds.maxProtein).toBeCloseTo(52, 5);
    expect(bounds.minCalories).toBeCloseTo(350, 5);
    expect(bounds.maxCalories).toBeCloseTo(650, 5);
    expect(bounds.minCarbs).toBeCloseTo(35, 5);
    expect(bounds.maxCarbs).toBeCloseTo(65, 5);
    expect(bounds.minFat).toBeCloseTo(14, 5);
    expect(bounds.maxFat).toBeCloseTo(26, 5);
  });
});

describe("classifyTier", () => {
  const target = { proteinG: 40, calories: 500 };

  it("classifies an exact match as p10", () => {
    expect(classifyTier({ proteinG: 40, caloriesKcal: 500 }, target)).toBe("p10");
  });

  it("classifies a candidate outside p10 but within p20 as p20", () => {
    expect(classifyTier({ proteinG: 46, caloriesKcal: 580 }, target)).toBe("p20");
  });

  it("returns null for a candidate outside even p30", () => {
    expect(classifyTier({ proteinG: 1000, caloriesKcal: 5000 }, target)).toBeNull();
  });

  // This is the exact bug this function fixes: a reconciliation nudge can
  // pick a candidate whose calories fall below the true p10 minimum even
  // though the slot was originally claimed at p10 — the label must reflect
  // the real deviation, not the stale pre-swap tier.
  it("correctly demotes a below-band candidate even when it's close to p10's edge", () => {
    // p10 minCalories = 450; 445 is just outside it.
    expect(classifyTier({ proteinG: 40, caloriesKcal: 445 }, target)).toBe("p20");
  });
});
