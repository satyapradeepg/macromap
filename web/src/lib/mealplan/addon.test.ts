import { describe, it, expect, vi } from "vitest";
import { buildAddonForSlot, type IngredientMacroLookup } from "./addon";
import type { MacroGapDirection } from "./reconciliation";
import type { DietaryContext } from "./ingredientSafety";
import type { PantryPriceContext } from "./pantryPricePreference";

const greekYogurt: IngredientMacroLookup = {
  id: 1256,
  name: "greek yogurt",
  caloriesPer100g: 61,
  proteinGPer100g: 10.3,
  carbsGPer100g: 3.64,
  fatGPer100g: 0.37,
  estimatedCostCentsPer100g: 71.43,
};

const apple: IngredientMacroLookup = {
  id: 9003,
  name: "apple",
  caloriesPer100g: 52,
  proteinGPer100g: 0.26,
  carbsGPer100g: 13.8,
  fatGPer100g: 0.17,
  estimatedCostCentsPer100g: 33.11,
};

function proteinGap(overshootPct = 0.1): MacroGapDirection {
  return { macro: "proteinG", direction: "increase", overshootPct };
}

const NO_RESTRICTIONS: DietaryContext = { dietaryStyles: [], allergies: [], dislikes: [] };

describe("buildAddonForSlot", () => {
  it("sizes the add-on to the 20% calorie cap for the slot", async () => {
    const fetcher = vi.fn().mockResolvedValue(greekYogurt);
    const slotCalories = 700; // cap = 140 kcal
    const addon = await buildAddonForSlot(slotCalories, proteinGap(), fetcher, NO_RESTRICTIONS);

    expect(fetcher).toHaveBeenCalledWith("greek yogurt");
    expect(addon).not.toBeNull();
    // 140 kcal / 61 kcal per 100g = ~229.5g, floored to nearest 5g = 225g
    expect(addon!.amountG).toBe(225);
    expect(addon!.caloriesKcal).toBeCloseTo((61 * 225) / 100, 5);
    expect(addon!.proteinG).toBeCloseTo((10.3 * 225) / 100, 5);
    expect(addon!.spoonacularIngredientId).toBe(1256);
  });

  it("never exceeds the calorie cap for the slot", async () => {
    const fetcher = vi.fn().mockResolvedValue(greekYogurt);
    const slotCalories = 500;
    const addon = await buildAddonForSlot(slotCalories, proteinGap(), fetcher, NO_RESTRICTIONS);
    expect(addon!.caloriesKcal).toBeLessThanOrEqual(slotCalories * 0.2);
  });

  it("picks the best-fit ingredient for each targeted macro when nothing is restricted", async () => {
    const fetcher = vi.fn().mockResolvedValue(greekYogurt);
    await buildAddonForSlot(700, { macro: "carbsG", direction: "increase", overshootPct: 0.1 }, fetcher, NO_RESTRICTIONS);
    expect(fetcher).toHaveBeenCalledWith("banana");

    await buildAddonForSlot(700, { macro: "fatG", direction: "increase", overshootPct: 0.1 }, fetcher, NO_RESTRICTIONS);
    expect(fetcher).toHaveBeenCalledWith("almonds");

    await buildAddonForSlot(700, { macro: "calories", direction: "increase", overshootPct: 0.1 }, fetcher, NO_RESTRICTIONS);
    expect(fetcher).toHaveBeenCalledWith("peanut butter");
  });

  it("returns null when the ingredient lookup fails", async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const addon = await buildAddonForSlot(700, proteinGap(), fetcher, NO_RESTRICTIONS);
    expect(addon).toBeNull();
  });

  it("returns null when a tiny meal's calorie cap rounds below the minimum add-on size", async () => {
    const fetcher = vi.fn().mockResolvedValue(greekYogurt);
    // cap = 30 * 0.2 = 6 kcal -> well under MIN_ADDON_AMOUNT_G worth of yogurt
    const addon = await buildAddonForSlot(30, proteinGap(), fetcher, NO_RESTRICTIONS);
    expect(addon).toBeNull();
  });

  // Safety: found and fixed July 15 2026 -- this file previously never
  // checked allergies/diet/dislikes at all.
  describe("dietary safety", () => {
    it("never calls the fetcher for a macro whose every candidate is unsafe (nut allergy, fat macro)", async () => {
      const fetcher = vi.fn().mockResolvedValue(greekYogurt);
      const ctx: DietaryContext = { dietaryStyles: [], allergies: ["nuts"], dislikes: [] };
      const addon = await buildAddonForSlot(700, { macro: "fatG", direction: "increase", overshootPct: 0.1 }, fetcher, ctx);
      // almonds/walnuts/peanut butter are ALL nut-tagged -- every candidate
      // for this macro is unsafe, so the fetcher must never be called and
      // no addon is returned, rather than falling through to an unsafe pick.
      expect(fetcher).not.toHaveBeenCalled();
      expect(addon).toBeNull();
    });

    it("never calls the fetcher for a macro whose every candidate is unsafe (vegan diet, protein macro)", async () => {
      const fetcher = vi.fn().mockResolvedValue(greekYogurt);
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
      const addon = await buildAddonForSlot(700, proteinGap(), fetcher, ctx);
      // greek yogurt/cottage cheese/protein powder are all non-vegan-compliant.
      expect(fetcher).not.toHaveBeenCalled();
      expect(addon).toBeNull();
    });

    it("skips a disliked candidate and picks the next safe alternative in the same role", async () => {
      const fetcher = vi.fn().mockResolvedValue(apple);
      const ctx: DietaryContext = { dietaryStyles: [], allergies: [], dislikes: ["banana"] };
      const addon = await buildAddonForSlot(700, { macro: "carbsG", direction: "increase", overshootPct: 0.1 }, fetcher, ctx);
      // banana is first-choice for carbsG but disliked -- should fall
      // through to apple (the next candidate), not skip the add-on
      // entirely, since a safe alternative genuinely exists.
      expect(fetcher).toHaveBeenCalledWith("apple");
      expect(fetcher).not.toHaveBeenCalledWith("banana");
      expect(addon).not.toBeNull();
    });

    it("an unrelated allergy doesn't affect a macro whose candidates are all safe", async () => {
      const fetcher = vi.fn().mockResolvedValue(greekYogurt);
      const ctx: DietaryContext = { dietaryStyles: [], allergies: ["nuts"], dislikes: [] };
      const addon = await buildAddonForSlot(700, proteinGap(), fetcher, ctx);
      expect(fetcher).toHaveBeenCalledWith("greek yogurt");
      expect(addon).not.toBeNull();
    });
  });

  // Pantry/price preference: retrofitted July 15 2026 after confirming
  // this file never considered either, unlike ranking.ts's recipe path.
  describe("pantry/price preference", () => {
    it("tries a pantry-matching candidate before the normal best-fit-first candidate", async () => {
      const fetcher = vi.fn().mockResolvedValue(apple);
      const pantryPriceCtx: PantryPriceContext = { pantryItemNames: ["apple"], budgetAware: false };
      const addon = await buildAddonForSlot(
        700,
        { macro: "carbsG", direction: "increase", overshootPct: 0.1 },
        fetcher,
        NO_RESTRICTIONS,
        pantryPriceCtx,
      );
      // banana is normally tried first for carbsG -- a pantry match on
      // apple should be tried first instead, even though nothing is unsafe.
      expect(fetcher).toHaveBeenCalledWith("apple");
      expect(fetcher).not.toHaveBeenCalledWith("banana");
      expect(addon).not.toBeNull();
    });

    it("prefers the cheapest known-cost candidate when budget-aware and no pantry match", async () => {
      // fatG's candidates: almonds (178.57), walnuts (239.29), peanut
      // butter (35.71) -- peanut butter is by far the cheapest but is
      // normally tried LAST (best-fit order puts almonds first).
      const peanutButter: IngredientMacroLookup = {
        id: 16098,
        name: "peanut butter",
        caloriesPer100g: 597,
        proteinGPer100g: 22.5,
        carbsGPer100g: 22.3,
        fatGPer100g: 51.1,
        estimatedCostCentsPer100g: 35.71,
      };
      const fetcher = vi.fn().mockResolvedValue(peanutButter);
      const pantryPriceCtx: PantryPriceContext = { pantryItemNames: [], budgetAware: true };
      const addon = await buildAddonForSlot(
        700,
        { macro: "fatG", direction: "increase", overshootPct: 0.1 },
        fetcher,
        NO_RESTRICTIONS,
        pantryPriceCtx,
      );
      expect(fetcher).toHaveBeenCalledWith("peanut butter");
      expect(fetcher).not.toHaveBeenCalledWith("almonds");
      expect(addon).not.toBeNull();
    });

    it("does not reorder by price when not budget-aware", async () => {
      const fetcher = vi.fn().mockResolvedValue(greekYogurt);
      await buildAddonForSlot(700, { macro: "fatG", direction: "increase", overshootPct: 0.1 }, fetcher, NO_RESTRICTIONS);
      expect(fetcher).toHaveBeenCalledWith("almonds"); // unchanged best-fit-first order
    });

    it("records the real estimated cost on the returned add-on", async () => {
      const fetcher = vi.fn().mockResolvedValue(greekYogurt);
      const addon = await buildAddonForSlot(700, proteinGap(), fetcher, NO_RESTRICTIONS);
      // 225g at 71.43 cents/100g
      expect(addon!.estimatedCostCents).toBeCloseTo((71.43 * 225) / 100, 2);
    });
  });
});
