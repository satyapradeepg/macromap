import { describe, it, expect } from "vitest";
import { answerReadOnlyQuestion } from "./answerReadOnlyQuestion";
import type { PlanSlotView, PlanView } from "@/app/plan/data";
import type { MealType } from "@/lib/mealplan/targets";

function slot(overrides: Partial<PlanSlotView> = {}): PlanSlotView {
  return {
    dayIndex: 0,
    mealType: "dinner",
    recipeId: 123,
    recipeTitle: "Seitan Stir-Fry with Rice and Broccoli",
    isComposed: false,
    aiComposed: false,
    isUnfilled: false,
    composedIngredients: null,
    recipeIngredients: [
      { name: "seitan", amount: 200, unit: "g" },
      { name: "rice", amount: 150, unit: "g" },
    ],
    imageUrl: null,
    servings: 1,
    calories: 600,
    proteinG: 40,
    carbsG: 60,
    fatG: 15,
    pricePerServingCents: null,
    scaleFactor: 1,
    toleranceTier: "p10",
    matchLabel: null,
    addon: null,
    ...overrides,
  };
}

function plan(overrides: Partial<PlanView> = {}): PlanView {
  return {
    id: "plan-1",
    generatedAt: "2026-08-12T00:00:00Z",
    reconciliationStatus: "within_band",
    weeklyTarget: { calories: 14000, proteinG: 700, carbsG: 1400, fatG: 400 },
    weeklyActual: { calories: 9000, proteinG: 500, carbsG: 900, fatG: 250 },
    slots: [slot()],
    blockedSlots: [],
    unresolvedDietaryConcerns: [],
    ...overrides,
  };
}

describe("answerReadOnlyQuestion", () => {
  it("returns the unsupported message regardless of plan state", () => {
    expect(answerReadOnlyQuestion("unsupported", null, null, null)).toMatch(/budget\/cost tracking isn't something/);
    expect(answerReadOnlyQuestion("unsupported", null, null, plan())).toMatch(/budget\/cost tracking isn't something/);
  });

  it("returns a no-plan message for any other topic when there's no plan", () => {
    expect(answerReadOnlyQuestion("remaining_weekly_macros", null, null, null)).toMatch(/don't have a generated plan/);
  });

  it("computes correct remaining weekly macros from target minus actual", () => {
    const answer = answerReadOnlyQuestion("remaining_weekly_macros", null, null, plan());
    expect(answer).toContain("9000");
    expect(answer).toContain("14000");
    expect(answer).toContain("5000"); // remaining calories
    expect(answer).toContain("200"); // remaining protein (700-500)
    expect(answer).toContain("500"); // remaining carbs (1400-900)
    expect(answer).toContain("150"); // remaining fat (400-250)
  });

  it("describes a specific meal's title, macros, and ingredients", () => {
    const answer = answerReadOnlyQuestion("specific_meal_details", 0, "dinner", plan());
    expect(answer).toContain("Seitan Stir-Fry with Rice and Broccoli");
    expect(answer).toContain("seitan");
    expect(answer).toContain("rice");
    expect(answer).toContain("600 cal");
  });

  it("asks a clarifying-style message when dayIndex/mealType are missing for specific_meal_details", () => {
    expect(answerReadOnlyQuestion("specific_meal_details", null, null, plan())).toMatch(/Which meal/);
  });

  it("reports a not-found message when the requested slot doesn't exist", () => {
    expect(answerReadOnlyQuestion("specific_meal_details", 3, "lunch" as MealType, plan())).toMatch(/couldn't find that meal/);
  });

  it("reports an honest 'no meal yet' message for an unfilled slot", () => {
    const p = plan({ slots: [slot({ isUnfilled: true, recipeTitle: "blocked: no candidates" })] });
    expect(answerReadOnlyQuestion("specific_meal_details", 0, "dinner", p)).toMatch(/doesn't have a meal filled in yet/);
  });

  it("summarizes today's filled slots and their combined calories", () => {
    const p = plan({
      slots: [
        slot({ dayIndex: 0, mealType: "breakfast", recipeTitle: "Oatmeal", calories: 400 }),
        slot({ dayIndex: 0, mealType: "dinner", recipeTitle: "Stir-Fry", calories: 600 }),
        slot({ dayIndex: 1, mealType: "dinner", recipeTitle: "Not Today", calories: 700 }),
      ],
    });
    const answer = answerReadOnlyQuestion("today_summary", null, null, p);
    expect(answer).toContain("Oatmeal");
    expect(answer).toContain("Stir-Fry");
    expect(answer).not.toContain("Not Today");
    expect(answer).toContain("1000 calories");
  });

  it("reports no meals for today when every day-0 slot is unfilled", () => {
    const p = plan({ slots: [slot({ dayIndex: 0, isUnfilled: true })] });
    expect(answerReadOnlyQuestion("today_summary", null, null, p)).toMatch(/don't see any meals filled in for today/);
  });
});
