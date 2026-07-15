import { describe, it, expect } from "vitest";
import {
  allSlotIds,
  perMealTarget,
  allMealTypeTargets,
  weeklyTarget,
  proteinFloorViolations,
  slotMechanism,
  MEALS_PER_WEEK,
  mealTypeToSpoonacularType,
  structuralCalorieFloorExceedsTarget,
  STRUCTURAL_CALORIE_FLOOR_TOTAL,
} from "./targets";

describe("allSlotIds", () => {
  it("enumerates exactly 35 slots in fixed Day1-Breakfast..Day7-Snack2 order", () => {
    const slots = allSlotIds();
    expect(slots).toHaveLength(MEALS_PER_WEEK);
    expect(slots[0]).toEqual({ dayIndex: 0, mealType: "breakfast" });
    expect(slots[slots.length - 1]).toEqual({ dayIndex: 6, mealType: "snack2" });
  });
});

describe("slotMechanism", () => {
  it("uses recipe search for breakfast/lunch/dinner", () => {
    expect(slotMechanism("breakfast")).toBe("recipe");
    expect(slotMechanism("lunch")).toBe("recipe");
    expect(slotMechanism("dinner")).toBe("recipe");
  });

  it("uses ingredient composition for snacks", () => {
    expect(slotMechanism("snack1")).toBe("composed");
    expect(slotMechanism("snack2")).toBe("composed");
  });
});

describe("perMealTarget / allMealTypeTargets / weeklyTarget", () => {
  // Chosen so every share's raw calories fall inside CALORIE_BOUNDS
  // (250-1200 for meals, 100-500 for snacks) — these tests exercise the
  // percentage split itself, not the clamp (see "absolute bounds" below).
  const daily = { calories: 2000, proteinG: 200, carbsG: 200, fatG: 60 };

  it("gives breakfast 20% of the daily total", () => {
    expect(perMealTarget(daily, "breakfast")).toEqual({ calories: 400, proteinG: 40, carbsG: 40, fatG: 12 });
  });

  it("gives lunch 32%, dinner 16%, and each snack 16%", () => {
    expect(perMealTarget(daily, "lunch")).toEqual({ calories: 640, proteinG: 64, carbsG: 64, fatG: 19.2 });
    expect(perMealTarget(daily, "dinner")).toEqual({ calories: 320, proteinG: 32, carbsG: 32, fatG: 9.6 });
    expect(perMealTarget(daily, "snack1")).toEqual({ calories: 320, proteinG: 32, carbsG: 32, fatG: 9.6 });
    expect(perMealTarget(daily, "snack2")).toEqual({ calories: 320, proteinG: 32, carbsG: 32, fatG: 9.6 });
  });

  it("allMealTypeTargets' five shares sum back to the daily total", () => {
    const targets = allMealTypeTargets(daily);
    const totalCalories = Object.values(targets).reduce((sum, t) => sum + t.calories, 0);
    const totalProtein = Object.values(targets).reduce((sum, t) => sum + t.proteinG, 0);
    expect(totalCalories).toBeCloseTo(daily.calories, 10);
    expect(totalProtein).toBeCloseTo(daily.proteinG, 10);
  });

  it("multiplies daily by 7 for weekly target", () => {
    expect(weeklyTarget(daily)).toEqual({ calories: 14000, proteinG: 1400, carbsG: 1400, fatG: 420 });
  });
});

describe("perMealTarget absolute bounds", () => {
  it("clamps a meal's calories down at the high extreme, preserving macro ratio", () => {
    // A very large, very-active bulker: 32% lunch share would be ~1815
    // kcal, well above the 1200 recipe-mechanism ceiling.
    const daily = { calories: 4537, proteinG: 270, carbsG: 580, fatG: 126 };
    const raw = daily.calories * 0.32; // ~1451.8, still over 1200 even before using the real 4537 example
    const lunch = perMealTarget(daily, "lunch");
    expect(lunch.calories).toBe(1200);
    // Ratio preserved: protein/calories should match the unclamped ratio.
    const rawProteinPerCalorie = (daily.proteinG * 0.32) / raw;
    expect(lunch.proteinG / lunch.calories).toBeCloseTo(rawProteinPerCalorie, 5);
  });

  it("clamps a meal's calories up at the low extreme, preserving macro ratio", () => {
    // A small, sedentary, older cutter: 20% breakfast share would be
    // ~198 kcal, below the 250 recipe-mechanism floor.
    const daily = { calories: 992, proteinG: 88, carbsG: 98, fatG: 27.5 };
    const breakfast = perMealTarget(daily, "breakfast");
    expect(breakfast.calories).toBe(250);
    const rawProteinPerCalorie = (daily.proteinG * 0.2) / (daily.calories * 0.2);
    expect(breakfast.proteinG / breakfast.calories).toBeCloseTo(rawProteinPerCalorie, 5);
  });

  it("uses the tighter composed-mechanism bounds for snacks", () => {
    // A high-calorie profile where even a 16% snack share exceeds the
    // composed-mechanism's 500 kcal ceiling (tighter than recipe's 1200).
    const daily = { calories: 4000, proteinG: 300, carbsG: 400, fatG: 100 };
    const snack = perMealTarget(daily, "snack1");
    expect(snack.calories).toBe(500);
  });

  it("does not clamp a normal, mid-range profile at all", () => {
    const daily = { calories: 2106, proteinG: 180, carbsG: 215, fatG: 58 };
    const targets = allMealTypeTargets(daily);
    expect(targets.breakfast.calories).toBeCloseTo(421.2, 5);
    expect(targets.lunch.calories).toBeCloseTo(673.92, 5);
  });

  // Floor split by meal type, audit round 2 (July 15 2026): breakfast and
  // lunch/dinner used to share one flat 250 kcal floor despite querying
  // genuinely different Spoonacular corpora. Live-checked real recipe
  // data before picking new numbers -- see the source comment on
  // CALORIE_BOUNDS for the full derivation.
  describe("meal-type-specific floor (breakfast 250 vs lunch/dinner 150)", () => {
    it("does not clamp dinner at 192 kcal -- above the new 150 floor, would have clamped to 250 under the old shared floor", () => {
      const daily = { calories: 1200, proteinG: 100, carbsG: 120, fatG: 33 };
      const dinner = perMealTarget(daily, "dinner");
      expect(dinner.calories).toBeCloseTo(1200 * 0.16, 5); // 192, unclamped
    });

    it("still clamps dinner up to 150 (not 250) when the raw share falls below even the lowered floor", () => {
      const daily = { calories: 800, proteinG: 70, carbsG: 80, fatG: 22 };
      const dinner = perMealTarget(daily, "dinner");
      expect(dinner.calories).toBe(150);
    });

    it("applies the same lowered 150 floor to lunch", () => {
      const daily = { calories: 400, proteinG: 40, carbsG: 40, fatG: 12 };
      const lunch = perMealTarget(daily, "lunch"); // raw = 400*0.32 = 128, below 150
      expect(lunch.calories).toBe(150);
    });

    it("still clamps breakfast up to 250, unaffected by the lunch/dinner change", () => {
      const daily = { calories: 992, proteinG: 88, carbsG: 98, fatG: 27.5 };
      const breakfast = perMealTarget(daily, "breakfast"); // raw ~198, below 250
      expect(breakfast.calories).toBe(250);
    });
  });

  // Disclosure half of finding 3 (audit round 2, July 15 2026) -- the
  // computed-target floor (tdee.ts's MIN_DAILY_CALORIES) protects the
  // common case, but a manual onboarding override can still land below
  // the meal-floor structural minimum. This is the check that catches it.
  describe("structuralCalorieFloorExceedsTarget", () => {
    it("computes 750 as today's structural floor total (250+150+150+100+100)", () => {
      expect(STRUCTURAL_CALORIE_FLOOR_TOTAL).toBe(750);
    });

    it("returns true when the daily target is below the structural floor", () => {
      expect(structuralCalorieFloorExceedsTarget(600)).toBe(true);
      expect(structuralCalorieFloorExceedsTarget(749)).toBe(true);
    });

    it("returns false once the daily target reaches or exceeds the structural floor", () => {
      expect(structuralCalorieFloorExceedsTarget(750)).toBe(false);
      expect(structuralCalorieFloorExceedsTarget(1200)).toBe(false);
    });
  });
});

describe("proteinFloorViolations", () => {
  const dailyProtein = 150; // floor = 18g (12%)

  it("returns no violations when every meal clears the floor", () => {
    const meals = [
      { mealType: "breakfast" as const, proteinG: 30 },
      { mealType: "lunch" as const, proteinG: 60 },
      { mealType: "dinner" as const, proteinG: 60 },
    ];
    expect(proteinFloorViolations(dailyProtein, meals)).toEqual([]);
  });

  it("flags a meal that falls below 12% of the daily protein target", () => {
    const meals = [
      { mealType: "breakfast" as const, proteinG: 5 }, // below 18g floor
      { mealType: "lunch" as const, proteinG: 85 },
      { mealType: "dinner" as const, proteinG: 60 },
    ];
    expect(proteinFloorViolations(dailyProtein, meals)).toEqual(["breakfast"]);
  });
});

describe("mealTypeToSpoonacularType", () => {
  it("maps breakfast to Spoonacular's breakfast type", () => {
    expect(mealTypeToSpoonacularType("breakfast")).toBe("breakfast");
  });

  it("maps both lunch and dinner to main course", () => {
    expect(mealTypeToSpoonacularType("lunch")).toBe("main course");
    expect(mealTypeToSpoonacularType("dinner")).toBe("main course");
  });

  it("throws for snack types rather than querying Spoonacular's thin snack corpus", () => {
    expect(() => mealTypeToSpoonacularType("snack1")).toThrow();
    expect(() => mealTypeToSpoonacularType("snack2")).toThrow();
  });
});
