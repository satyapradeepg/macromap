import { describe, it, expect } from "vitest";
import { STATIC_INGREDIENT_MACROS, lookupIngredientMacrosStatic } from "./staticIngredientMacros";
import { allPoolIngredientNames } from "./snackComposition";
import { ADDON_INGREDIENT_OPTIONS_BY_MACRO } from "./addon";

describe("staticIngredientMacros", () => {
  it("covers every name in the snack composition pool", () => {
    for (const name of allPoolIngredientNames()) {
      expect(lookupIngredientMacrosStatic(name)).not.toBeNull();
    }
  });

  it("covers every name addon.ts maps a macro gap to", () => {
    for (const names of Object.values(ADDON_INGREDIENT_OPTIONS_BY_MACRO)) {
      for (const name of names) {
        expect(lookupIngredientMacrosStatic(name)).not.toBeNull();
      }
    }
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(lookupIngredientMacrosStatic("Greek Yogurt")).toEqual(STATIC_INGREDIENT_MACROS["greek yogurt"]);
    expect(lookupIngredientMacrosStatic("  banana  ")).toEqual(STATIC_INGREDIENT_MACROS.banana);
  });

  it("returns null for an unrecognized ingredient", () => {
    expect(lookupIngredientMacrosStatic("dragon fruit")).toBeNull();
  });

  it("every entry has plausible positive macro values", () => {
    for (const [name, entry] of Object.entries(STATIC_INGREDIENT_MACROS)) {
      expect(entry.caloriesPer100g, name).toBeGreaterThan(0);
      expect(entry.proteinGPer100g, name).toBeGreaterThanOrEqual(0);
      expect(entry.carbsGPer100g, name).toBeGreaterThanOrEqual(0);
      expect(entry.fatGPer100g, name).toBeGreaterThanOrEqual(0);
      expect(entry.id, name).toBeGreaterThan(0);
    }
  });
});
