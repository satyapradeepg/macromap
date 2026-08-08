import { describe, it, expect } from "vitest";
import { buildMealPlanIcs } from "./calendarExport";
import type { PlanSlotView, PlanView } from "./data";

function makeSlot(overrides: Partial<PlanSlotView> = {}): PlanSlotView {
  return {
    dayIndex: 0,
    mealType: "lunch",
    recipeId: 123,
    recipeTitle: "Mushroom Tofu Stew",
    isComposed: false,
    aiComposed: false,
    isUnfilled: false,
    composedIngredients: null,
    recipeIngredients: [{ name: "tofu", amount: 200, unit: "g" }],
    imageUrl: null,
    servings: 1,
    calories: 722,
    proteinG: 55,
    carbsG: 99,
    fatG: 17,
    pricePerServingCents: null,
    scaleFactor: 1,
    toleranceTier: "p10",
    matchLabel: null,
    addon: null,
    ...overrides,
  };
}

function makePlan(slots: PlanSlotView[]): PlanView {
  return {
    id: "plan-1",
    generatedAt: "2026-08-08T00:00:00Z",
    reconciliationStatus: "within_band",
    weeklyTarget: { calories: 14000, proteinG: 1000, carbsG: 1500, fatG: 400 },
    weeklyActual: { calories: 14000, proteinG: 1000, carbsG: 1500, fatG: 400 },
    slots,
    blockedSlots: [],
    unresolvedDietaryConcerns: [],
  };
}

// A fixed reference date -- Aug 12, 2026. day_index no longer ties to a
// real weekday at all, so this is just "the day the plan was
// generated/exported," nothing more.
const TODAY = new Date(2026, 7, 12);

describe("buildMealPlanIcs", () => {
  it("maps day_index 0 to today, always", () => {
    const plan = makePlan([makeSlot({ dayIndex: 0, mealType: "lunch" })]);
    const ics = buildMealPlanIcs(plan, TODAY);
    expect(ics).toContain("DTSTART:20260812T123000");
  });

  it("maps day_index N to N days from today", () => {
    const plan = makePlan([makeSlot({ dayIndex: 4, mealType: "dinner" })]);
    const ics = buildMealPlanIcs(plan, TODAY);
    expect(ics).toContain("DTSTART:20260816T183000");
  });

  it("maps the last day of the rolling week (day_index 6) 6 days out", () => {
    const plan = makePlan([makeSlot({ dayIndex: 6, mealType: "breakfast" })]);
    const ics = buildMealPlanIcs(plan, TODAY);
    expect(ics).toContain("DTSTART:20260818T080000");
  });

  it("skips an unfilled slot", () => {
    const plan = makePlan([makeSlot({ dayIndex: 2, isUnfilled: true })]);
    const ics = buildMealPlanIcs(plan, TODAY);
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("titles the event with the meal type and recipe name", () => {
    const plan = makePlan([makeSlot({ dayIndex: 2, mealType: "dinner", recipeTitle: "Baked Cheese Manicotti" })]);
    const ics = buildMealPlanIcs(plan, TODAY);
    expect(ics).toContain("SUMMARY:Dinner: Baked Cheese Manicotti");
  });

  it("escapes commas and semicolons in the title/description per RFC 5545", () => {
    const plan = makePlan([
      makeSlot({
        dayIndex: 2,
        recipeTitle: "Rice, Beans; and Greens",
        recipeIngredients: [{ name: "rice, white", amount: 1, unit: "cup" }],
      }),
    ]);
    const ics = buildMealPlanIcs(plan, TODAY);
    expect(ics).toContain("SUMMARY:Lunch: Rice\\, Beans\\; and Greens");
    expect(ics).toContain("rice\\, white");
  });

  it("formats composed-snack ingredients in whole grams", () => {
    const plan = makePlan([
      makeSlot({
        dayIndex: 2,
        mealType: "snack1",
        isComposed: true,
        composedIngredients: [{ name: "cottage cheese", amountG: 215.4 }],
        recipeIngredients: null,
      }),
    ]);
    const ics = buildMealPlanIcs(plan, TODAY);
    expect(ics).toContain("215g cottage cheese");
  });

  it("includes an add-on line when present", () => {
    const plan = makePlan([
      makeSlot({
        dayIndex: 2,
        addon: { ingredientName: "sunflower seed butter", amountG: 10, caloriesKcal: 58, proteinG: 2, carbsG: 2, fatG: 5 },
      }),
    ]);
    const ics = buildMealPlanIcs(plan, TODAY);
    expect(ics).toContain("+ 10g sunflower seed butter");
  });

  it("produces a valid VCALENDAR wrapper even with zero events", () => {
    const plan = makePlan([]);
    const ics = buildMealPlanIcs(plan, TODAY);
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics.trim().endsWith("END:VCALENDAR")).toBe(true);
  });
});
