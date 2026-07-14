import { describe, it, expect } from "vitest";
import {
  allSlotIds,
  perMealTarget,
  allMealTypeTargets,
  weeklyTarget,
  proteinFloorViolations,
  MEALS_PER_WEEK,
  mealTypeToSpoonacularType,
} from "./targets";

describe("allSlotIds", () => {
  it("enumerates exactly 21 slots in fixed Day1-Breakfast..Day7-Dinner order", () => {
    const slots = allSlotIds();
    expect(slots).toHaveLength(MEALS_PER_WEEK);
    expect(slots[0]).toEqual({ dayIndex: 0, mealType: "breakfast" });
    expect(slots[slots.length - 1]).toEqual({ dayIndex: 6, mealType: "dinner" });
  });
});

describe("perMealTarget / allMealTypeTargets / weeklyTarget", () => {
  const daily = { calories: 1500, proteinG: 150, carbsG: 150, fatG: 50 };

  it("gives breakfast 20% of the daily total", () => {
    expect(perMealTarget(daily, "breakfast")).toEqual({ calories: 300, proteinG: 30, carbsG: 30, fatG: 10 });
  });

  it("gives lunch and dinner 40% each of the daily total", () => {
    expect(perMealTarget(daily, "lunch")).toEqual({ calories: 600, proteinG: 60, carbsG: 60, fatG: 20 });
    expect(perMealTarget(daily, "dinner")).toEqual({ calories: 600, proteinG: 60, carbsG: 60, fatG: 20 });
  });

  it("allMealTypeTargets' three shares sum back to the daily total", () => {
    const targets = allMealTypeTargets(daily);
    expect(targets.breakfast.calories + targets.lunch.calories + targets.dinner.calories).toBeCloseTo(
      daily.calories,
      10,
    );
    expect(targets.breakfast.proteinG + targets.lunch.proteinG + targets.dinner.proteinG).toBeCloseTo(
      daily.proteinG,
      10,
    );
  });

  it("multiplies daily by 7 for weekly target", () => {
    expect(weeklyTarget(daily)).toEqual({ calories: 10500, proteinG: 1050, carbsG: 1050, fatG: 350 });
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
});
