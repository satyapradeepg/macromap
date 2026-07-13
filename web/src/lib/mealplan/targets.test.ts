import { describe, it, expect } from "vitest";
import { allSlotIds, perMealTarget, weeklyTarget, MEALS_PER_WEEK } from "./targets";

describe("allSlotIds", () => {
  it("enumerates exactly 21 slots in fixed Day1-Breakfast..Day7-Dinner order", () => {
    const slots = allSlotIds();
    expect(slots).toHaveLength(MEALS_PER_WEEK);
    expect(slots[0]).toEqual({ dayIndex: 0, mealType: "breakfast" });
    expect(slots[slots.length - 1]).toEqual({ dayIndex: 6, mealType: "dinner" });
  });
});

describe("perMealTarget / weeklyTarget", () => {
  const daily = { calories: 1500, proteinG: 150, carbsG: 150, fatG: 50 };

  it("divides daily by 3 for per-meal target", () => {
    expect(perMealTarget(daily)).toEqual({ calories: 500, proteinG: 50, carbsG: 50, fatG: 50 / 3 });
  });

  it("multiplies daily by 7 for weekly target", () => {
    expect(weeklyTarget(daily)).toEqual({ calories: 10500, proteinG: 1050, carbsG: 1050, fatG: 350 });
  });
});
