import { describe, it, expect } from "vitest";
import { aggregateGroceryList, type SlotIngredientEntry, type AddonEntry, type PantryExclusionItem } from "./aggregate";

function slotIngredient(overrides: Partial<SlotIngredientEntry> = {}): SlotIngredientEntry {
  return { id: 1, name: "Chicken Breast", metricAmount: 200, metricUnit: "g", ...overrides };
}

function pantryItem(overrides: Partial<PantryExclusionItem> = {}): PantryExclusionItem {
  return { name: "irrelevant name", spoonacularIngredientId: null, amount: null, unit: null, ...overrides };
}

describe("aggregateGroceryList", () => {
  it("sums quantities across slots for the same ingredient id", () => {
    const lines = aggregateGroceryList(
      [
        [slotIngredient({ id: 1, metricAmount: 200 })],
        [slotIngredient({ id: 1, metricAmount: 150 })],
      ],
      [],
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ingredientId: 1, totalAmount: 350, unit: "g", needsManualCombine: false });
  });

  it("merges a slot's ingredient with a matching add-on for the same id", () => {
    const addon: AddonEntry = { ingredientId: 1, ingredientName: "Chicken Breast", amountG: 50 };
    const lines = aggregateGroceryList([[slotIngredient({ id: 1, metricAmount: 200 })]], [addon]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ totalAmount: 250, unit: "g", sourceCount: 2 });
  });

  it("keeps an add-on-only ingredient with no matching slot ingredient as its own line", () => {
    const addon: AddonEntry = { ingredientId: 9, ingredientName: "Greek Yogurt", amountG: 100 };
    const lines = aggregateGroceryList([[slotIngredient({ id: 1 })]], [addon]);

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.ingredientId === 9)).toMatchObject({ totalAmount: 100, unit: "g" });
  });

  it("does not merge same-id entries with mismatched units, and flags both for manual combine", () => {
    const lines = aggregateGroceryList(
      [
        [slotIngredient({ id: 1, metricAmount: 200, metricUnit: "g" })],
        [slotIngredient({ id: 1, metricAmount: 1, metricUnit: "cup" })],
      ],
      [],
    );

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.needsManualCombine).toBe(true);
      expect(line.ingredientId).toBe(1);
    }
  });

  it("treats unit case/whitespace differences as the same unit", () => {
    const lines = aggregateGroceryList(
      [
        [slotIngredient({ id: 1, metricAmount: 200, metricUnit: "G" })],
        [slotIngredient({ id: 1, metricAmount: 100, metricUnit: " g " })],
      ],
      [],
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].needsManualCombine).toBe(false);
    expect(lines[0].totalAmount).toBe(300);
  });

  it("excludes a line by ingredient id when the pantry item has a resolved id", () => {
    const pantry = [pantryItem({ spoonacularIngredientId: 1 })];
    const lines = aggregateGroceryList([[slotIngredient({ id: 1 })], [slotIngredient({ id: 2, name: "Rice" })]], [], pantry);

    expect(lines).toHaveLength(1);
    expect(lines[0].ingredientId).toBe(2);
  });

  it("does not exclude by name when the pantry item's id is resolved but doesn't match", () => {
    const pantry = [pantryItem({ name: "Chicken Breast", spoonacularIngredientId: 999 })];
    const lines = aggregateGroceryList([[slotIngredient({ id: 1 })]], [], pantry);

    expect(lines).toHaveLength(1);
  });

  it("falls back to word-boundary name matching when the pantry item's id is unresolved", () => {
    const pantry = [pantryItem({ name: "egg" })];
    const lines = aggregateGroceryList(
      [
        [slotIngredient({ id: 1, name: "eggs" })],
        [slotIngredient({ id: 2, name: "eggplant" })],
      ],
      [],
      pantry,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("eggplant");
  });

  it("returns an empty list when there are no ingredients", () => {
    expect(aggregateGroceryList([], [])).toEqual([]);
  });

  describe("pantry quantity subtraction", () => {
    it("hard-excludes the line when a matching pantry item has no structured quantity", () => {
      const pantry = [pantryItem({ spoonacularIngredientId: 1 })];
      const lines = aggregateGroceryList([[slotIngredient({ id: 1, metricAmount: 200 })]], [], pantry);
      expect(lines).toHaveLength(0);
    });

    it("reduces a weight-unit line by a comparable pantry quantity", () => {
      const pantry = [pantryItem({ spoonacularIngredientId: 1, amount: 1, unit: "lb" })]; // ~453.592g
      const lines = aggregateGroceryList([[slotIngredient({ id: 1, metricAmount: 500, metricUnit: "g" })]], [], pantry);

      expect(lines).toHaveLength(1);
      expect(lines[0].totalAmount).toBeCloseTo(500 - 453.592);
    });

    it("fully excludes the line when the pantry quantity covers or exceeds the need", () => {
      const pantry = [pantryItem({ spoonacularIngredientId: 1, amount: 2, unit: "kg" })];
      const lines = aggregateGroceryList([[slotIngredient({ id: 1, metricAmount: 500, metricUnit: "g" })]], [], pantry);
      expect(lines).toHaveLength(0);
    });

    it("directly subtracts matching 'other'-category descriptors, tolerant of plurals", () => {
      const pantry = [pantryItem({ spoonacularIngredientId: 5, amount: 2, unit: "cloves" })];
      const lines = aggregateGroceryList(
        [[slotIngredient({ id: 5, name: "Garlic", metricAmount: 10, metricUnit: "clove" })]],
        [],
        pantry,
      );

      expect(lines).toHaveLength(1);
      expect(lines[0].totalAmount).toBe(8);
    });

    it("hard-excludes when the pantry quantity's unit category doesn't match the line's", () => {
      const pantry = [pantryItem({ spoonacularIngredientId: 1, amount: 1, unit: "bag" })];
      const lines = aggregateGroceryList([[slotIngredient({ id: 1, metricAmount: 500, metricUnit: "g" })]], [], pantry);
      expect(lines).toHaveLength(0);
    });

    it("hard-excludes when both sides are 'other' but the descriptor differs", () => {
      const pantry = [pantryItem({ spoonacularIngredientId: 1, amount: 1, unit: "bag" })];
      const lines = aggregateGroceryList(
        [[slotIngredient({ id: 1, metricAmount: 3, metricUnit: "can" })]],
        [],
        pantry,
      );
      expect(lines).toHaveLength(0);
    });

    it("sums contributions from multiple matching pantry items before subtracting", () => {
      const pantry = [
        pantryItem({ spoonacularIngredientId: 1, amount: 100, unit: "g" }),
        pantryItem({ spoonacularIngredientId: 1, amount: 200, unit: "g" }),
      ];
      const lines = aggregateGroceryList([[slotIngredient({ id: 1, metricAmount: 500, metricUnit: "g" })]], [], pantry);

      expect(lines).toHaveLength(1);
      expect(lines[0].totalAmount).toBe(200);
    });
  });
});
