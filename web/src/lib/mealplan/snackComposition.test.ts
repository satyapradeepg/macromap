import { describe, it, expect } from "vitest";
import {
  composeSnack,
  composedSnackTitle,
  allPoolIngredientNames,
  INGREDIENT_POOL,
  type IngredientMacroLookup,
} from "./snackComposition";

// Real macro data (greek yogurt/banana live-confirmed earlier this
// project; almond values are standard USDA per-100g figures).
const pool: Record<string, IngredientMacroLookup> = {
  "greek yogurt": { id: 1256, name: "greek yogurt", caloriesPer100g: 61, proteinGPer100g: 10.3, carbsGPer100g: 3.64, fatGPer100g: 0.37 },
  "cottage cheese": { id: 1017, name: "cottage cheese", caloriesPer100g: 98, proteinGPer100g: 11.1, carbsGPer100g: 3.4, fatGPer100g: 4.3 },
  "protein powder": { id: 19334, name: "protein powder", caloriesPer100g: 379, proteinGPer100g: 80, carbsGPer100g: 8, fatGPer100g: 5 },
  banana: { id: 9040, name: "banana", caloriesPer100g: 89, proteinGPer100g: 1.09, carbsGPer100g: 22.8, fatGPer100g: 0.33 },
  apple: { id: 9003, name: "apple", caloriesPer100g: 52, proteinGPer100g: 0.26, carbsGPer100g: 13.8, fatGPer100g: 0.17 },
  orange: { id: 9200, name: "orange", caloriesPer100g: 47, proteinGPer100g: 0.94, carbsGPer100g: 11.8, fatGPer100g: 0.12 },
  almonds: { id: 12061, name: "almonds", caloriesPer100g: 579, proteinGPer100g: 21.2, carbsGPer100g: 21.6, fatGPer100g: 49.9 },
  "peanut butter": { id: 16098, name: "peanut butter", caloriesPer100g: 588, proteinGPer100g: 25, carbsGPer100g: 20, fatGPer100g: 50 },
  walnuts: { id: 12155, name: "walnuts", caloriesPer100g: 654, proteinGPer100g: 15.2, carbsGPer100g: 13.7, fatGPer100g: 65.2 },
};

describe("composeSnack", () => {
  it("lands within ~15% on every macro for a real snack-scale target", () => {
    // 16%-share snack target for the real 2106/180/215/58 test profile.
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, pool, 0); // seed 0 -> greek yogurt/banana/almonds

    expect(snack.totalProteinG).toBeGreaterThan(target.proteinG * 0.85);
    expect(snack.totalProteinG).toBeLessThan(target.proteinG * 1.2);
    expect(snack.totalCarbsG).toBeGreaterThan(target.carbsG * 0.85);
    expect(snack.totalCarbsG).toBeLessThan(target.carbsG * 1.2);
    expect(snack.totalFatG).toBeGreaterThan(target.fatG * 0.8);
    expect(snack.totalFatG).toBeLessThan(target.fatG * 1.2);
    // 3 distinct ingredients: protein/carb/fat roles all found a real gap
    // to close for this target.
    expect(snack.ingredients).toHaveLength(3);
  });

  it("uses greek yogurt/banana/almonds at seed 0 (first pool option per role)", () => {
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, pool, 0);
    const names = snack.ingredients.map((i) => i.ingredientName);
    expect(names).toEqual(["greek yogurt", "banana", "almonds"]);
  });

  it("rotates to different pool ingredients at a different variety seed", () => {
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, pool, 1); // seed 1 -> 2nd option per role
    const names = snack.ingredients.map((i) => i.ingredientName);
    // Cottage cheese (4.3g fat/100g) sized to hit the protein target alone
    // already contributes more fat than the 9g target — the fat-role
    // ingredient (peanut butter) is correctly skipped rather than adding
    // even more on top, same "never fakes progress" principle as addon.ts.
    expect(names).toEqual(["cottage cheese", "apple"]);
  });

  it("never exceeds a sensible amount for a tiny target (skips ingredients below the minimum)", () => {
    const target = { calories: 5, proteinG: 0.5, carbsG: 0.5, fatG: 0.2 };
    const snack = composeSnack(target, pool, 0);
    // Gaps this small round below the 10g minimum for every role.
    expect(snack.ingredients).toHaveLength(0);
  });

  it("skips a role entirely when the pool has no lookup for it", () => {
    const partialPool = { "greek yogurt": pool["greek yogurt"], banana: pool.banana };
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, partialPool, 0);
    expect(snack.ingredients.map((i) => i.ingredientName)).toEqual(["greek yogurt", "banana"]);
  });
});

describe("composedSnackTitle", () => {
  it("joins ingredient names, title-cased", () => {
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, pool, 0);
    expect(composedSnackTitle(snack)).toBe("Greek Yogurt + Banana + Almonds");
  });
});

describe("allPoolIngredientNames / INGREDIENT_POOL", () => {
  it("returns all 9 pool ingredient names across the 3 roles", () => {
    expect(allPoolIngredientNames()).toHaveLength(9);
    expect(INGREDIENT_POOL.protein).toHaveLength(3);
    expect(INGREDIENT_POOL.carb).toHaveLength(3);
    expect(INGREDIENT_POOL.fat).toHaveLength(3);
  });
});
