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

  // Fixes a real bug found live 2026-07-25: Spoonacular's own
  // extendedIngredients[].id is a non-unique placeholder (confirmed live:
  // -1 for "mayonaisse", a misspelling it couldn't resolve) whenever it
  // can't identify an ingredient at all -- grouping purely by id used to
  // silently merge two DIFFERENT unresolved ingredients that happened to
  // share the same placeholder id into one garbled line.
  it("does not merge two different unresolved ingredients that share the same placeholder id", () => {
    const lines = aggregateGroceryList(
      [
        [slotIngredient({ id: -1, name: "mayonaisse", metricAmount: 30, metricUnit: "g" })],
        [slotIngredient({ id: -1, name: "garnish", metricAmount: 5, metricUnit: "g" })],
      ],
      [],
    );

    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.name === "mayonaisse")).toMatchObject({ totalAmount: 30 });
    expect(lines.find((l) => l.name === "garnish")).toMatchObject({ totalAmount: 5 });
  });

  it("still merges repeat occurrences of the SAME unresolved ingredient sharing a placeholder id", () => {
    const lines = aggregateGroceryList(
      [
        [slotIngredient({ id: -1, name: "mayonaisse", metricAmount: 30, metricUnit: "g" })],
        [slotIngredient({ id: -1, name: "mayonaisse", metricAmount: 20, metricUnit: "g" })],
      ],
      [],
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: "mayonaisse", totalAmount: 50, ingredientId: -1 });
  });

  it("treats a placeholder id (e.g. 0) as untrustworthy for grouping just like a negative one", () => {
    const lines = aggregateGroceryList(
      [
        [slotIngredient({ id: 0, name: "or", metricAmount: 1, metricUnit: "g" })],
        [slotIngredient({ id: 0, name: "garnish", metricAmount: 1, metricUnit: "g" })],
      ],
      [],
    );

    expect(lines).toHaveLength(2);
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

  // identityMatch.ts's LLM/cache resolution overrides the loose word-
  // boundary namesOverlap fallback when present -- fixes a real bug found
  // live 2026-07-25: pantry "green onions" wrongly matched a bare "onion"
  // line via namesOverlap (both share the word "onion"), even though
  // they're genuinely different produce. matchedLineNames lets a caller
  // say "no, only THIS specific line is actually the same item."
  it("uses matchedLineNames instead of namesOverlap when present, even if namesOverlap would also match", () => {
    const pantry = [pantryItem({ name: "green onions", matchedLineNames: new Set(["green onions"]) })];
    const lines = aggregateGroceryList(
      [
        [slotIngredient({ id: 1, name: "onion" })],
        [slotIngredient({ id: 2, name: "green onions" })],
      ],
      [],
      pantry,
    );

    // namesOverlap alone would have matched BOTH lines (both contain the
    // word "onion"/"onions") -- matchedLineNames restricts it to only the
    // genuinely-same-item line.
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("onion");
  });

  it("falls back to namesOverlap when matchedLineNames is null (resolution unavailable)", () => {
    const pantry = [pantryItem({ name: "egg", matchedLineNames: null })];
    const lines = aggregateGroceryList([[slotIngredient({ id: 1, name: "eggs" })]], [], pantry);
    expect(lines).toHaveLength(0);
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

    it("pools one pantry item's quantity across multiple matching lines instead of reapplying it to each (bug fix 2026-07-25)", () => {
      const pantry = [pantryItem({ name: "garlic", amount: 2, unit: "cloves" })];
      const lines = aggregateGroceryList(
        [
          [
            slotIngredient({ id: 5, name: "Garlic", metricAmount: 1.4, metricUnit: "clove" }),
            slotIngredient({ id: 6, name: "Garlic Cloves", metricAmount: 2.6, metricUnit: "cloves" }),
          ],
        ],
        [],
        pantry,
      );

      // The first 1.4 of the pantry's 2 cloves fully covers line 5, which
      // drops out; only the remaining 0.6 is left for line 6, which should
      // land at 2.6 - 0.6 = 2.0 -- NOT 2.6 - 2 = 0.6, which is what
      // reapplying the item's full amount to each line independently
      // (the pre-fix bug) would have produced.
      expect(lines).toHaveLength(1);
      expect(lines[0].ingredientId).toBe(6);
      expect(lines[0].totalAmount).toBeCloseTo(2.0);
    });

    it("still subtracts a usable match's contribution when another matching pantry item on the same line has no structured quantity (bug fix 2026-07-25)", () => {
      const pantry = [
        pantryItem({ name: "parmesan cheese", amount: 50, unit: "g" }),
        pantryItem({ name: "parmesan cheese" }), // no structured quantity -- previously discarded the line entirely
      ];
      const lines = aggregateGroceryList(
        [[slotIngredient({ id: 1, name: "Parmesan Cheese", metricAmount: 105.1, metricUnit: "g" })]],
        [],
        pantry,
      );

      expect(lines).toHaveLength(1);
      expect(lines[0].totalAmount).toBeCloseTo(55.1);
    });

    it("still hard-excludes when every matching pantry item is unusable, even with more than one match", () => {
      const pantry = [pantryItem({ name: "parmesan cheese" }), pantryItem({ name: "parmesan cheese" })];
      const lines = aggregateGroceryList(
        [[slotIngredient({ id: 1, name: "Parmesan Cheese", metricAmount: 105.1, metricUnit: "g" })]],
        [],
        pantry,
      );

      expect(lines).toHaveLength(0);
    });
  });
});
