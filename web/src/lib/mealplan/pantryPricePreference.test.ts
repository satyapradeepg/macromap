import { describe, it, expect } from "vitest";
import { rankByPantryAndPrice, type PantryPriceContext } from "./pantryPricePreference";

interface TestItem {
  name: string;
  costCentsPer100g: number | null;
}

const NO_PREFERENCE: PantryPriceContext = { pantryItemNames: [], budgetAware: false };

describe("rankByPantryAndPrice", () => {
  it("leaves order unchanged with no pantry match and not budget-aware", () => {
    const candidates: TestItem[] = [
      { name: "banana", costCentsPer100g: 13 },
      { name: "apple", costCentsPer100g: 33 },
      { name: "orange", costCentsPer100g: 22 },
    ];
    const result = rankByPantryAndPrice(candidates, NO_PREFERENCE);
    expect(result.ordered.map((c) => c.name)).toEqual(["banana", "apple", "orange"]);
    expect(result.preferredCount).toBe(3);
  });

  it("puts a single pantry match first, but tops the preferred tier up to 2 so there's still something to rotate with", () => {
    const candidates: TestItem[] = [
      { name: "banana", costCentsPer100g: 13 },
      { name: "apple", costCentsPer100g: 33 },
      { name: "orange", costCentsPer100g: 22 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: ["apple"], budgetAware: false };
    const result = rankByPantryAndPrice(candidates, ctx);
    expect(result.ordered[0].name).toBe("apple");
    expect(result.preferredCount).toBe(2);
  });

  it("matches a pantry item that's a substring of the ingredient name and vice versa, still topped up to 2 preferred", () => {
    const candidates: TestItem[] = [
      { name: "greek yogurt", costCentsPer100g: 71 },
      { name: "cottage cheese", costCentsPer100g: 50 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: ["yogurt"], budgetAware: false };
    const result = rankByPantryAndPrice(candidates, ctx);
    expect(result.ordered[0].name).toBe("greek yogurt");
    expect(result.preferredCount).toBe(2);
  });

  // Regression test for the live bug found July 15 2026 (audit round 2): a
  // 15-item real pantry produced 1 distinct snack combo across all 14
  // snack slots, because a real pantry almost always matches exactly ONE
  // pool item per macro role -- preferredCount used to collapse to 1,
  // leaving composeSnack's variety-seed rotation nothing to rotate within.
  it("restores 2-way rotation when only a single pantry item matches a role", () => {
    const carbRole: TestItem[] = [
      { name: "banana", costCentsPer100g: 13.33 },
      { name: "apple", costCentsPer100g: 33.11 },
      { name: "orange", costCentsPer100g: 22.22 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: ["banana"], budgetAware: false };
    const result = rankByPantryAndPrice(carbRole, ctx);
    expect(result.preferredCount).toBe(2);
    expect(result.ordered[0].name).toBe("banana");

    const seeds = [0, 1, 2, 3];
    const picks = new Set(seeds.map((s) => result.ordered[s % result.preferredCount].name));
    expect(picks.size).toBe(2);
  });

  it("prefers the cheaper of the backup slots when also budget-aware", () => {
    const carbRole: TestItem[] = [
      { name: "banana", costCentsPer100g: 13.33 },
      { name: "apple", costCentsPer100g: 33.11 },
      { name: "orange", costCentsPer100g: 22.22 },
    ];
    // "apple" is the pantry match, but the priciest of the three -- the
    // topped-up 2nd preferred slot should still favor the cheaper backup
    // (banana over orange) when budget-aware, not an arbitrary order.
    const ctx: PantryPriceContext = { pantryItemNames: ["apple"], budgetAware: true };
    const result = rankByPantryAndPrice(carbRole, ctx);
    expect(result.ordered.map((c) => c.name)).toEqual(["apple", "banana", "orange"]);
    expect(result.preferredCount).toBe(2);
  });

  it("groups multiple pantry matches together at the front, preserving their relative order", () => {
    const candidates: TestItem[] = [
      { name: "banana", costCentsPer100g: 13 },
      { name: "apple", costCentsPer100g: 33 },
      { name: "orange", costCentsPer100g: 22 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: ["apple", "orange"], budgetAware: false };
    const result = rankByPantryAndPrice(candidates, ctx);
    expect(result.ordered.map((c) => c.name)).toEqual(["apple", "orange", "banana"]);
    expect(result.preferredCount).toBe(2);
  });

  it("pantry preference wins over budget preference when both apply", () => {
    const candidates: TestItem[] = [
      { name: "banana", costCentsPer100g: 13 },
      { name: "apple", costCentsPer100g: 33 }, // pricier, but the pantry item
      { name: "orange", costCentsPer100g: 22 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: ["apple"], budgetAware: true };
    const result = rankByPantryAndPrice(candidates, ctx);
    expect(result.ordered[0].name).toBe("apple");
    expect(result.preferredCount).toBe(2);
  });

  it("orders by cheapest known cost when budget-aware and no pantry match, keeping the cheaper half (min 2) preferred", () => {
    const candidates: TestItem[] = [
      { name: "walnuts", costCentsPer100g: 239.29 },
      { name: "almonds", costCentsPer100g: 178.57 },
      { name: "peanut butter", costCentsPer100g: 35.71 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: [], budgetAware: true };
    const result = rankByPantryAndPrice(candidates, ctx);
    expect(result.ordered.map((c) => c.name)).toEqual(["peanut butter", "almonds", "walnuts"]);
    // Rank-based (not a percentage tie-band, see source comment): keeps
    // the cheaper 2 of 3 preferred, excluding only the priciest (walnuts).
    expect(result.preferredCount).toBe(2);
  });

  // Regression test for the live bug found July 15 2026: a tight-budget
  // Pro profile got the byte-identical "Cottage Cheese + Banana" 14/14
  // times, because the strict-cheapest-only comparison never has a real
  // tie given the actual fixed-pool costs (2nd-cheapest is always
  // 43-570% pricier -- see the source comment's derivation). This proves
  // the fix actually restores rotation for the REAL numbers involved, not
  // just a synthetic case with convenient ties.
  it("restores 2-way rotation for the real fixed-pool costs that caused live 14/14 repetition", () => {
    const proteinRole: TestItem[] = [
      { name: "greek yogurt", costCentsPer100g: 71.43 },
      { name: "cottage cheese", costCentsPer100g: 50.0 },
      { name: "protein powder", costCentsPer100g: 278.57 },
    ];
    const carbRole: TestItem[] = [
      { name: "banana", costCentsPer100g: 13.33 },
      { name: "apple", costCentsPer100g: 33.11 },
      { name: "orange", costCentsPer100g: 22.22 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: [], budgetAware: true };

    const proteinResult = rankByPantryAndPrice(proteinRole, ctx);
    expect(proteinResult.preferredCount).toBe(2);
    expect(proteinResult.ordered.slice(0, 2).map((c) => c.name).sort()).toEqual(["cottage cheese", "greek yogurt"]);

    const carbResult = rankByPantryAndPrice(carbRole, ctx);
    expect(carbResult.preferredCount).toBe(2);
    expect(carbResult.ordered.slice(0, 2).map((c) => c.name).sort()).toEqual(["banana", "orange"]);

    // The seed-based caller (composeSnack) would now rotate between 2
    // real options instead of always landing on index 0.
    const seeds = [0, 1, 2, 3];
    const picks = new Set(seeds.map((s) => proteinResult.ordered[s % proteinResult.preferredCount].name));
    expect(picks.size).toBe(2);
  });

  it("groups tied-cheapest candidates together", () => {
    const candidates: TestItem[] = [
      { name: "a", costCentsPer100g: 50 },
      { name: "b", costCentsPer100g: 20 },
      { name: "c", costCentsPer100g: 20 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: [], budgetAware: true };
    const result = rankByPantryAndPrice(candidates, ctx);
    expect(result.preferredCount).toBe(2);
    expect(result.ordered.slice(0, 2).map((c) => c.name).sort()).toEqual(["b", "c"]);
  });

  it("does not reorder by price when fewer than 2 candidates have known cost", () => {
    const candidates: TestItem[] = [
      { name: "a", costCentsPer100g: 50 },
      { name: "b", costCentsPer100g: null },
      { name: "c", costCentsPer100g: null },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: [], budgetAware: true };
    const result = rankByPantryAndPrice(candidates, ctx);
    expect(result.ordered.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(result.preferredCount).toBe(3);
  });

  it("ignores budget preference entirely when not budget-aware", () => {
    const candidates: TestItem[] = [
      { name: "walnuts", costCentsPer100g: 239.29 },
      { name: "peanut butter", costCentsPer100g: 35.71 },
    ];
    const result = rankByPantryAndPrice(candidates, NO_PREFERENCE);
    expect(result.ordered.map((c) => c.name)).toEqual(["walnuts", "peanut butter"]);
    expect(result.preferredCount).toBe(2);
  });

  // Audit round 3 (July 15 2026): the bare bidirectional substring check
  // let pantry "nut" match both "walnuts" and "peanut butter", collapsing
  // distinct allergen-relevant pool items into one preference bucket.
  describe("bidirectional substring false-positive fixes (audit round 3, July 15 2026)", () => {
    it("does not match pantry 'nut' against 'walnuts' or 'peanut butter'", () => {
      const candidates: TestItem[] = [
        { name: "walnuts", costCentsPer100g: 239.29 },
        { name: "peanut butter", costCentsPer100g: 35.71 },
        { name: "banana", costCentsPer100g: 13 },
      ];
      const ctx: PantryPriceContext = { pantryItemNames: ["nut"], budgetAware: false };
      const result = rankByPantryAndPrice(candidates, ctx);
      expect(result.ordered).toEqual(candidates);
      expect(result.preferredCount).toBe(3);
    });

    it("still matches a real whole-word pantry item (e.g. 'walnuts' matches 'walnuts')", () => {
      const candidates: TestItem[] = [
        { name: "walnuts", costCentsPer100g: 239.29 },
        { name: "banana", costCentsPer100g: 13 },
      ];
      const ctx: PantryPriceContext = { pantryItemNames: ["walnuts"], budgetAware: false };
      const result = rankByPantryAndPrice(candidates, ctx);
      expect(result.ordered[0].name).toBe("walnuts");
    });

    // Same latent defect as the live-confirmed dislike-leak fixed in
    // openEndedIngredientSafety.ts 2026-07-27 (wordBoundaryIncludes is a
    // per-file copy, not shared): a plural pantry name against a singular
    // occurrence inside a longer compound pool-item name isn't saved by
    // trying both directions -- neither direction finds the full phrase.
    it("matches a plural pantry name against a singular occurrence inside a compound pool-item name", () => {
      const candidates: TestItem[] = [
        { name: "mushroom broth", costCentsPer100g: 40 },
        { name: "banana", costCentsPer100g: 13 },
      ];
      const ctx: PantryPriceContext = { pantryItemNames: ["mushrooms"], budgetAware: false };
      const result = rankByPantryAndPrice(candidates, ctx);
      expect(result.ordered[0].name).toBe("mushroom broth");
      // A single pantry match still reports preferredCount 2 (the
      // documented minimum-2-preferred floor from the July 15 2026 fix
      // above) -- this assertion isn't about that floor, just confirming
      // the match itself fired (>=1) rather than 0/no-match.
      expect(result.preferredCount).toBeGreaterThanOrEqual(1);
    });
  });
});
