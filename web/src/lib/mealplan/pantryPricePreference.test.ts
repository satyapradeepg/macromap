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

  it("puts a pantry match first and reports a preferredCount of 1", () => {
    const candidates: TestItem[] = [
      { name: "banana", costCentsPer100g: 13 },
      { name: "apple", costCentsPer100g: 33 },
      { name: "orange", costCentsPer100g: 22 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: ["apple"], budgetAware: false };
    const result = rankByPantryAndPrice(candidates, ctx);
    expect(result.ordered[0].name).toBe("apple");
    expect(result.preferredCount).toBe(1);
  });

  it("matches a pantry item that's a substring of the ingredient name and vice versa", () => {
    const candidates: TestItem[] = [
      { name: "greek yogurt", costCentsPer100g: 71 },
      { name: "cottage cheese", costCentsPer100g: 50 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: ["yogurt"], budgetAware: false };
    const result = rankByPantryAndPrice(candidates, ctx);
    expect(result.ordered[0].name).toBe("greek yogurt");
    expect(result.preferredCount).toBe(1);
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
    expect(result.preferredCount).toBe(1);
  });

  it("orders by cheapest known cost when budget-aware and no pantry match", () => {
    const candidates: TestItem[] = [
      { name: "walnuts", costCentsPer100g: 239.29 },
      { name: "almonds", costCentsPer100g: 178.57 },
      { name: "peanut butter", costCentsPer100g: 35.71 },
    ];
    const ctx: PantryPriceContext = { pantryItemNames: [], budgetAware: true };
    const result = rankByPantryAndPrice(candidates, ctx);
    expect(result.ordered.map((c) => c.name)).toEqual(["peanut butter", "almonds", "walnuts"]);
    expect(result.preferredCount).toBe(1);
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
});
