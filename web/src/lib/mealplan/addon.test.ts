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

const banana: IngredientMacroLookup = {
  id: 9040,
  name: "banana",
  caloriesPer100g: 89,
  proteinGPer100g: 1.09,
  carbsGPer100g: 22.84,
  fatGPer100g: 0.33,
  estimatedCostCentsPer100g: 24.19,
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

  // Persona audit 2026-07-31, finding #5: live-confirmed 8 of 9 addons
  // across a real unrestricted week were banana -- this loop used to
  // always try `ordered` starting at index 0, so the first-safe-and-
  // resolving candidate won essentially every time. Same rotation idiom
  // snackComposition.ts's pickFromPool already uses (varietySeed %
  // preferredCount), applied here for the first time.
  describe("variety rotation (varietySeed)", () => {
    const carbGap: MacroGapDirection = { macro: "carbsG", direction: "increase", overshootPct: 0.1 };
    const NO_PANTRY_CTX: PantryPriceContext = { pantryItemNames: [], budgetAware: false };

    it("defaults to today's exact always-try-index-0-first behavior when varietySeed is omitted", async () => {
      const fetcher = vi.fn().mockResolvedValue(apple);
      await buildAddonForSlot(700, carbGap, fetcher, NO_RESTRICTIONS);
      expect(fetcher).toHaveBeenCalledWith("banana");
    });

    it("rotates which safe candidate is tried first as varietySeed changes, wrapping back around", async () => {
      const fetcher = vi.fn().mockResolvedValue(apple);

      await buildAddonForSlot(700, carbGap, fetcher, NO_RESTRICTIONS, NO_PANTRY_CTX, Infinity, 0);
      expect(fetcher).toHaveBeenNthCalledWith(1, "banana");

      await buildAddonForSlot(700, carbGap, fetcher, NO_RESTRICTIONS, NO_PANTRY_CTX, Infinity, 1);
      expect(fetcher).toHaveBeenNthCalledWith(2, "apple");

      await buildAddonForSlot(700, carbGap, fetcher, NO_RESTRICTIONS, NO_PANTRY_CTX, Infinity, 2);
      expect(fetcher).toHaveBeenNthCalledWith(3, "orange");

      await buildAddonForSlot(700, carbGap, fetcher, NO_RESTRICTIONS, NO_PANTRY_CTX, Infinity, 3);
      expect(fetcher).toHaveBeenNthCalledWith(4, "banana");
    });

    it("still falls through to every other safe candidate on a lookup failure, regardless of rotation", async () => {
      // seed=2 tries orange first; orange fails to resolve here, so it
      // must fall through to banana next (the rotated list's 2nd entry),
      // exactly the same fallback guarantee as before this fix.
      const fetcher = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(banana);
      const addon = await buildAddonForSlot(700, carbGap, fetcher, NO_RESTRICTIONS, NO_PANTRY_CTX, Infinity, 2);
      expect(fetcher).toHaveBeenNthCalledWith(1, "orange");
      expect(fetcher).toHaveBeenNthCalledWith(2, "banana");
      expect(addon).not.toBeNull();
      expect(addon!.ingredientName).toBe("banana");
    });
  });

  it("returns null when a tiny meal's calorie cap rounds below the minimum add-on size", async () => {
    const fetcher = vi.fn().mockResolvedValue(greekYogurt);
    // cap = 30 * 0.2 = 6 kcal -> well under MIN_ADDON_AMOUNT_G worth of yogurt
    const addon = await buildAddonForSlot(30, proteinGap(), fetcher, NO_RESTRICTIONS);
    expect(addon).toBeNull();
  });

  // Realism cap (ported from snackComposition.ts, 2026-07-28): the 20%
  // calorie cap alone has no opinion on gram amount, so a low-density
  // ingredient on a large-calorie slot previously had nothing else stopping
  // an unrealistic serving.
  describe("realistic portion cap", () => {
    const banana: IngredientMacroLookup = {
      id: 9040,
      name: "banana",
      caloriesPer100g: 89,
      proteinGPer100g: 1.09,
      carbsGPer100g: 22.8,
      fatGPer100g: 0.33,
      estimatedCostCentsPer100g: 13.33,
    };

    it("rejects an add-on that the 20% calorie cap alone would have allowed but exceeds the ingredient's realistic ceiling", async () => {
      const fetcher = vi.fn().mockResolvedValue(banana);
      // cap = 2000 * 0.2 = 400 kcal -> 400/89*100 = ~449g, floored to 445g,
      // well past banana's 250g realistic ceiling (staticIngredientMacros.ts).
      const addon = await buildAddonForSlot(2000, { macro: "carbsG", direction: "increase", overshootPct: 0.1 }, fetcher, NO_RESTRICTIONS);
      expect(addon).toBeNull();
    });

    it("still returns a normal add-on when the sized amount stays under the realistic ceiling", async () => {
      const fetcher = vi.fn().mockResolvedValue(banana);
      // cap = 700 * 0.2 = 140 kcal -> 140/89*100 = ~157g, floored to 155g, under 250g.
      const addon = await buildAddonForSlot(700, { macro: "carbsG", direction: "increase", overshootPct: 0.1 }, fetcher, NO_RESTRICTIONS);
      expect(addon).not.toBeNull();
      expect(addon!.amountG).toBe(155);
    });
  });

  // Gap-aware sizing (2026-07-28): the add-on should never use more than the
  // real remaining gap needs, even when the 20% calorie cap would allow more.
  describe("gap-aware sizing (neededAmount)", () => {
    it("sizes to the actual remaining gap when it's smaller than the 20% calorie cap", async () => {
      const fetcher = vi.fn().mockResolvedValue(greekYogurt);
      const slotCalories = 700; // cap-derived: 140/61*100 = ~229.5g
      // Only 5g of protein still needed -> 5/10.3*100 = ~48.5g, well under
      // the cap-derived amount.
      const addon = await buildAddonForSlot(slotCalories, proteinGap(), fetcher, NO_RESTRICTIONS, undefined, 5);
      expect(addon).not.toBeNull();
      expect(addon!.amountG).toBe(45);
      expect(addon!.proteinG).toBeCloseTo((10.3 * 45) / 100, 5);
    });

    it("falls back to the 20% calorie cap when neededAmount exceeds it (a single add-on still can't close a huge gap alone)", async () => {
      const fetcher = vi.fn().mockResolvedValue(greekYogurt);
      const slotCalories = 700;
      // 1000g of protein needed -- far more than one add-on should ever
      // supply; the cap-derived 225g ceiling from the first test still wins.
      const addon = await buildAddonForSlot(slotCalories, proteinGap(), fetcher, NO_RESTRICTIONS, undefined, 1000);
      expect(addon).not.toBeNull();
      expect(addon!.amountG).toBe(225);
    });

    it("rejects when the gap-derived amount rounds below the minimum add-on size", async () => {
      const fetcher = vi.fn().mockResolvedValue(greekYogurt);
      // 1g of protein needed -> 1/10.3*100 = ~9.7g, floors below MIN_ADDON_AMOUNT_G.
      const addon = await buildAddonForSlot(700, proteinGap(), fetcher, NO_RESTRICTIONS, undefined, 1);
      expect(addon).toBeNull();
    });

    it("interacts correctly with the realism cap: a large gap-derived need still gets rejected if it exceeds the per-ingredient ceiling", async () => {
      const banana: IngredientMacroLookup = {
        id: 9040,
        name: "banana",
        caloriesPer100g: 89,
        proteinGPer100g: 1.09,
        carbsGPer100g: 22.8,
        fatGPer100g: 0.33,
        estimatedCostCentsPer100g: 13.33,
      };
      const fetcher = vi.fn().mockResolvedValue(banana);
      // Huge slot + huge carb need -> gap-derived amount alone would be
      // ~300g (300/22.8*100... i.e. needing 68.4g carbs), still over
      // banana's 250g realistic cap.
      const addon = await buildAddonForSlot(
        5000,
        { macro: "carbsG", direction: "increase", overshootPct: 0.1 },
        fetcher,
        NO_RESTRICTIONS,
        undefined,
        70,
      );
      expect(addon).toBeNull();
    });
  });

  // Safety: found and fixed July 15 2026 -- this file previously never
  // checked allergies/diet/dislikes at all.
  describe("dietary safety", () => {
    it("falls through to the widened fat-role options for a nut allergy instead of finding nothing (audit round 2, July 15 2026)", async () => {
      const fetcher = vi.fn().mockResolvedValue(greekYogurt);
      const ctx: DietaryContext = { dietaryStyles: [], allergies: ["nuts"], dislikes: [] };
      const addon = await buildAddonForSlot(700, { macro: "fatG", direction: "increase", overshootPct: 0.1 }, fetcher, ctx);
      // almonds/walnuts/peanut butter are ALL nut-tagged -- before the pool
      // was widened, every candidate for this macro was unsafe and the
      // fetcher was never called. sunflower seed butter (added the same
      // day precisely for this case) is the first safe option now.
      expect(fetcher).toHaveBeenCalledWith("sunflower seed butter");
      expect(addon).not.toBeNull();
    });

    it("falls through to the widened protein-role options for a vegan profile instead of finding nothing (audit round 2, July 15 2026)", async () => {
      const fetcher = vi.fn().mockResolvedValue(greekYogurt);
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
      const addon = await buildAddonForSlot(700, proteinGap(), fetcher, ctx);
      // greek yogurt/cottage cheese/protein powder are all non-vegan-
      // compliant. pea protein powder (added the same day precisely for
      // this case) is the first safe option now.
      expect(fetcher).toHaveBeenCalledWith("pea protein powder");
      expect(addon).not.toBeNull();
    });

    // Direct regression test for the live bug this pool expansion fixes:
    // vegan + nut allergy + soy allergy used to leave BOTH the protein
    // and fat roles with zero safe options (17% of calorie target,
    // engine-audit-2026-07-15-round2.md finding 4). Confirms the fetcher
    // is never even called with an unsafe candidate for either macro.
    it("finds a safe option for both protein and fat when vegan + nut allergy + soy allergy stack (regression)", async () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: ["nuts", "soy"], dislikes: [] };

      const proteinFetcher = vi.fn().mockResolvedValue(greekYogurt);
      const proteinAddon = await buildAddonForSlot(700, proteinGap(), proteinFetcher, ctx);
      expect(proteinFetcher).toHaveBeenCalledWith("pea protein powder");
      expect(proteinFetcher).not.toHaveBeenCalledWith("greek yogurt");
      expect(proteinFetcher).not.toHaveBeenCalledWith("cottage cheese");
      expect(proteinFetcher).not.toHaveBeenCalledWith("protein powder");
      expect(proteinAddon).not.toBeNull();

      const fatFetcher = vi.fn().mockResolvedValue(greekYogurt);
      const fatAddon = await buildAddonForSlot(700, { macro: "fatG", direction: "increase", overshootPct: 0.1 }, fatFetcher, ctx);
      expect(fatFetcher).toHaveBeenCalledWith("sunflower seed butter");
      expect(fatFetcher).not.toHaveBeenCalledWith("almonds");
      expect(fatFetcher).not.toHaveBeenCalledWith("walnuts");
      expect(fatFetcher).not.toHaveBeenCalledWith("peanut butter");
      expect(fatAddon).not.toBeNull();
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
