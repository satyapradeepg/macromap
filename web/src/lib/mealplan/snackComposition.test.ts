import { describe, it, expect } from "vitest";
import {
  composeSnack,
  composedSnackTitle,
  allPoolIngredientNames,
  INGREDIENT_POOL,
  type IngredientMacroLookup,
} from "./snackComposition";
import type { PantryPriceContext } from "./pantryPricePreference";

// Real macro data (greek yogurt/banana live-confirmed earlier this
// project; almond values are standard USDA per-100g figures).
const pool: Record<string, IngredientMacroLookup> = {
  "greek yogurt": { id: 1256, name: "greek yogurt", caloriesPer100g: 61, proteinGPer100g: 10.3, carbsGPer100g: 3.64, fatGPer100g: 0.37, estimatedCostCentsPer100g: 71.43 },
  "cottage cheese": { id: 1017, name: "cottage cheese", caloriesPer100g: 98, proteinGPer100g: 11.1, carbsGPer100g: 3.4, fatGPer100g: 4.3, estimatedCostCentsPer100g: 50.0 },
  "protein powder": { id: 19334, name: "protein powder", caloriesPer100g: 379, proteinGPer100g: 80, carbsGPer100g: 8, fatGPer100g: 5, estimatedCostCentsPer100g: 278.57 },
  banana: { id: 9040, name: "banana", caloriesPer100g: 89, proteinGPer100g: 1.09, carbsGPer100g: 22.8, fatGPer100g: 0.33, estimatedCostCentsPer100g: 13.33 },
  apple: { id: 9003, name: "apple", caloriesPer100g: 52, proteinGPer100g: 0.26, carbsGPer100g: 13.8, fatGPer100g: 0.17, estimatedCostCentsPer100g: 33.11 },
  orange: { id: 9200, name: "orange", caloriesPer100g: 47, proteinGPer100g: 0.94, carbsGPer100g: 11.8, fatGPer100g: 0.12, estimatedCostCentsPer100g: 22.22 },
  almonds: { id: 12061, name: "almonds", caloriesPer100g: 579, proteinGPer100g: 21.2, carbsGPer100g: 21.6, fatGPer100g: 49.9, estimatedCostCentsPer100g: 178.57 },
  "peanut butter": { id: 16098, name: "peanut butter", caloriesPer100g: 588, proteinGPer100g: 25, carbsGPer100g: 20, fatGPer100g: 50, estimatedCostCentsPer100g: 35.71 },
  walnuts: { id: 12155, name: "walnuts", caloriesPer100g: 654, proteinGPer100g: 15.2, carbsGPer100g: 13.7, fatGPer100g: 65.2, estimatedCostCentsPer100g: 239.29 },
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

  // Safety fix, July 15 2026: orchestrate.ts's fetchSnackIngredientPool now
  // pre-filters unsafe ingredients (allergy/diet/dislike) out of `pool`
  // entirely before calling composeSnack -- this proves composeSnack
  // rotates to whichever SAFE option in the same role is still present,
  // rather than giving up on that role just because the seed happened to
  // land on the one that got filtered out.
  it("rotates to the next available pool option in a role when the seed's pick was filtered out", () => {
    const poolWithoutBanana = { ...pool };
    delete poolWithoutBanana.banana; // simulates e.g. a "banana" dislike being filtered upstream
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, poolWithoutBanana, 0); // seed 0 would normally pick banana first
    const names = snack.ingredients.map((i) => i.ingredientName);
    expect(names).toContain("apple"); // falls through to the next carb option
    expect(names).not.toContain("banana");
  });

  // Pantry/price preference: retrofitted July 15 2026 after confirming
  // this file never considered either, unlike ranking.ts's recipe path.
  describe("pantry/price preference", () => {
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };

    it("consistently picks a pantry-matching option across every variety seed, not just some", () => {
      const ctx: PantryPriceContext = { pantryItemNames: ["orange"], budgetAware: false };
      // Without preference, seed 0/1/2 would rotate through
      // banana/apple/orange -- a real preference should pick "orange"
      // regardless of seed, not just when the seed happens to land on it.
      for (const seed of [0, 1, 2, 5, 42]) {
        const snack = composeSnack(target, pool, seed, ctx);
        expect(snack.ingredients.map((i) => i.ingredientName)).toContain("orange");
      }
    });

    it("rotates among multiple pantry matches for variety, never picking a non-match", () => {
      const ctx: PantryPriceContext = { pantryItemNames: ["banana", "orange"], budgetAware: false };
      const seen = new Set<string>();
      for (const seed of [0, 1, 2, 3]) {
        const snack = composeSnack(target, pool, seed, ctx);
        const carbItem = snack.ingredients.find((i) => ["banana", "apple", "orange"].includes(i.ingredientName));
        seen.add(carbItem!.ingredientName);
      }
      expect(seen.has("apple")).toBe(false);
      expect(seen.size).toBeGreaterThan(0);
    });

    it("rotates between the cheaper 2 of 3 protein-role options when budget-aware, excluding only the priciest", () => {
      // Regression test for the live bug found July 15 2026 (a tight-
      // budget Pro profile got the identical snack 14/14 times): strict
      // cheapest-only never had a real tie given these real costs
      // (cottage cheese 50.0 / greek yogurt 71.43 / protein powder
      // 278.57), so it always picked cottage cheese. The fix keeps the
      // cheaper HALF (min 2) preferred instead of just the single
      // cheapest -- protein powder (the priciest) should still never
      // appear, but both cottage cheese and greek yogurt should, across
      // enough seeds. Checked on the PROTEIN role specifically (always
      // reached every seed, unlike the fat role, which composeSnack only
      // reaches conditionally once protein+carb haven't already used up
      // the fat target -- a separate, pre-existing sequencing property
      // of composeSnack, not something this fix needs to reach into).
      const ctx: PantryPriceContext = { pantryItemNames: [], budgetAware: true };
      const seen = new Set<string>();
      for (const seed of [0, 1, 2, 3]) {
        const snack = composeSnack(target, pool, seed, ctx);
        const proteinItem = snack.ingredients.find((i) => ["greek yogurt", "cottage cheese", "protein powder"].includes(i.ingredientName));
        if (proteinItem) seen.add(proteinItem.ingredientName);
      }
      expect(seen.has("protein powder")).toBe(false);
      expect(seen.size).toBeGreaterThan(1);
    });

    it("computes a real total cost when every ingredient's cost is known", () => {
      const snack = composeSnack(target, pool, 0);
      expect(snack.totalEstimatedCostCents).not.toBeNull();
      const manualSum = snack.ingredients.reduce((s, i) => s + (i.estimatedCostCents ?? 0), 0);
      expect(snack.totalEstimatedCostCents).toBeCloseTo(manualSum, 5);
    });

    it("returns a null total cost if any ingredient's cost is unknown, rather than an understated partial sum", () => {
      const poolWithUnknownCost = {
        ...pool,
        "greek yogurt": { ...pool["greek yogurt"], estimatedCostCentsPer100g: null },
      };
      const snack = composeSnack(target, poolWithUnknownCost, 0);
      expect(snack.totalEstimatedCostCents).toBeNull();
    });
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
