import { describe, it, expect } from "vitest";
import { pluralizeUnit } from "./unitFormatting";

// 2026-07-30 UI pass: fixes "1 cups water" showing in the real recipe
// modal's ingredient list -- neither PlanView.tsx's formatIngredientAmount
// nor GroceryList.tsx's formatAmount had any plural awareness before this.
describe("pluralizeUnit", () => {
  it("singularizes a plural-looking unit when the rounded amount is exactly 1", () => {
    expect(pluralizeUnit("cups", 1)).toBe("cup");
    expect(pluralizeUnit("cup", 1)).toBe("cup");
  });

  it("pluralizes a singular unit when the rounded amount isn't 1", () => {
    expect(pluralizeUnit("cup", 2)).toBe("cups");
    expect(pluralizeUnit("cup", 0.8)).toBe("cups");
    expect(pluralizeUnit("pound", 1.6)).toBe("pounds");
  });

  it("leaves an already-plural unit alone when the amount isn't 1", () => {
    expect(pluralizeUnit("cups", 2)).toBe("cups");
  });

  it("never pluralizes a short/metric unit, matching GroceryList's existing length<=2 heuristic", () => {
    expect(pluralizeUnit("g", 200)).toBe("g");
    expect(pluralizeUnit("g", 1)).toBe("g");
    expect(pluralizeUnit("oz", 1)).toBe("oz");
  });

  it("leaves a unit already ending in a double s alone at singular amounts (rare, not one of Spoonacular's common word units)", () => {
    expect(pluralizeUnit("glass", 1)).toBe("glass");
  });

  it("returns an empty string unchanged", () => {
    expect(pluralizeUnit("", 3)).toBe("");
  });
});
