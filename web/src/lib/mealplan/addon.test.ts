import { describe, it, expect, vi } from "vitest";
import { buildAddonForSlot, type IngredientMacroLookup } from "./addon";
import type { MacroGapDirection } from "./reconciliation";

const greekYogurt: IngredientMacroLookup = {
  id: 1256,
  name: "greek yogurt",
  caloriesPer100g: 61,
  proteinGPer100g: 10.3,
  carbsGPer100g: 3.64,
  fatGPer100g: 0.37,
};

function proteinGap(overshootPct = 0.1): MacroGapDirection {
  return { macro: "proteinG", direction: "increase", overshootPct };
}

describe("buildAddonForSlot", () => {
  it("sizes the add-on to the 17.5% calorie cap for the slot", async () => {
    const fetcher = vi.fn().mockResolvedValue(greekYogurt);
    const slotCalories = 700; // cap = 122.5 kcal
    const addon = await buildAddonForSlot(slotCalories, proteinGap(), fetcher);

    expect(fetcher).toHaveBeenCalledWith("greek yogurt");
    expect(addon).not.toBeNull();
    // 122.5 kcal / 61 kcal per 100g = ~200.8g, rounded to nearest 5g = 200g
    expect(addon!.amountG).toBe(200);
    expect(addon!.caloriesKcal).toBeCloseTo((61 * 200) / 100, 5);
    expect(addon!.proteinG).toBeCloseTo((10.3 * 200) / 100, 5);
    expect(addon!.spoonacularIngredientId).toBe(1256);
  });

  it("never exceeds the calorie cap for the slot", async () => {
    const fetcher = vi.fn().mockResolvedValue(greekYogurt);
    const slotCalories = 500;
    const addon = await buildAddonForSlot(slotCalories, proteinGap(), fetcher);
    expect(addon!.caloriesKcal).toBeLessThanOrEqual(slotCalories * 0.175);
  });

  it("picks the ingredient matching the targeted macro", async () => {
    const fetcher = vi.fn().mockResolvedValue(greekYogurt);
    await buildAddonForSlot(700, { macro: "carbsG", direction: "increase", overshootPct: 0.1 }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("banana");

    await buildAddonForSlot(700, { macro: "fatG", direction: "increase", overshootPct: 0.1 }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("almonds");

    await buildAddonForSlot(700, { macro: "calories", direction: "increase", overshootPct: 0.1 }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("peanut butter");
  });

  it("returns null when the ingredient lookup fails", async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const addon = await buildAddonForSlot(700, proteinGap(), fetcher);
    expect(addon).toBeNull();
  });

  it("returns null when a tiny meal's calorie cap rounds below the minimum add-on size", async () => {
    const fetcher = vi.fn().mockResolvedValue(greekYogurt);
    // cap = 30 * 0.175 = 5.25 kcal -> well under MIN_ADDON_AMOUNT_G worth of yogurt
    const addon = await buildAddonForSlot(30, proteinGap(), fetcher);
    expect(addon).toBeNull();
  });
});
