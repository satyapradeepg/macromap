import { describe, it, expect } from "vitest";
import {
  buildPantryRemainingTracker,
  buildTrackerFromKnownConsumption,
  pantryCoverage,
  commitPantryConsumption,
  releasePantryConsumption,
  type PantryItemMatchInfo,
} from "./pantryRemaining";
import type { CandidateIngredient, PantryItem } from "./ranking";

function pantryItem(overrides: Partial<PantryItem> = {}): PantryItem {
  return { name: "irrelevant name", spoonacularIngredientId: null, amount: null, unit: null, ...overrides };
}

function ing(overrides: Partial<CandidateIngredient> = {}): CandidateIngredient {
  return { id: 1, name: "Chicken Breast", amount: 1, unit: "lb", metricAmount: 450, metricUnit: "g", ...overrides };
}

function matchInfo(entries: Record<number, Partial<PantryItemMatchInfo>>): Map<number, PantryItemMatchInfo> {
  const map = new Map<number, PantryItemMatchInfo>();
  for (const [index, info] of Object.entries(entries)) {
    map.set(Number(index), { matchedIngredientNames: null, unitConversionRates: null, ...info });
  }
  return map;
}

describe("buildPantryRemainingTracker", () => {
  it("builds an unlimited pool (category null) when the item has no structured quantity", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "chicken breast" })], new Map());
    expect(tracker.pools).toHaveLength(1);
    expect(tracker.pools[0].category).toBeNull();
    expect(tracker.pools[0].remainingBase).toBe(0);
  });

  it("converts a weight quantity to grams base", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ amount: 1, unit: "lb" })], new Map());
    expect(tracker.pools[0].category).toBe("weight");
    expect(tracker.pools[0].remainingBase).toBeCloseTo(453.592);
  });

  it("keeps an 'other' quantity in its own declared unit, plural-tolerant", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ amount: 2, unit: "cloves" })], new Map());
    expect(tracker.pools[0].category).toBe("other");
    expect(tracker.pools[0].otherDescriptor).toBe("clove");
    expect(tracker.pools[0].remainingBase).toBe(2);
  });

  it("attaches matchInfo by pantry item index", () => {
    const items = [pantryItem({ name: "a" }), pantryItem({ name: "b" })];
    const tracker = buildPantryRemainingTracker(
      items,
      matchInfo({ 1: { matchedIngredientNames: new Set(["b ingredient"]) } }),
    );
    expect(tracker.pools[0].matchedIngredientNames).toBeNull();
    expect(tracker.pools[1].matchedIngredientNames).toEqual(new Set(["b ingredient"]));
  });
});

describe("pantryCoverage (read-only)", () => {
  it("returns false when nothing matches", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "chicken breast" })], new Map());
    expect(pantryCoverage(tracker, [ing({ name: "white rice" })])).toEqual([false]);
  });

  it("returns true for an unlimited pool on any match, regardless of quantity", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "chicken breast" })], new Map());
    expect(pantryCoverage(tracker, [ing({ name: "chicken breast" })])).toEqual([true]);
  });

  it("matches by resolved spoonacularIngredientId, ignoring name entirely", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "unrelated label", spoonacularIngredientId: 101 })], new Map());
    expect(pantryCoverage(tracker, [ing({ id: 101, name: "anything" })])).toEqual([true]);
  });

  it("falls back to word-boundary name matching when unresolved", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "Chicken Breast" })], new Map());
    expect(pantryCoverage(tracker, [ing({ name: "boneless skinless chicken breast" })])).toEqual([true]);
  });

  it("does not false-positive on a bare substring (pea vs peanut oil)", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "pea" })], new Map());
    expect(pantryCoverage(tracker, [ing({ name: "peanut oil" })])).toEqual([false]);
  });

  // namesOverlap tries both directions, but that alone doesn't save a
  // plural pantry name against a singular occurrence buried in a longer
  // compound ingredient name -- e.g. "mushrooms" vs "mushroom broth":
  // (a,b) needs the whole phrase "mushroom broth" inside "mushrooms" (no),
  // (b,a) needs "mushrooms" inside "mushroom broth" (no, it's singular
  // there). Same latent defect as the live-confirmed dislike-leak fixed
  // in openEndedIngredientSafety.ts 2026-07-27, applied here too since
  // wordBoundaryIncludes is a per-file copy, not a shared function.
  it("matches a plural pantry name against a singular occurrence inside a compound ingredient name", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "mushrooms" })], new Map());
    expect(pantryCoverage(tracker, [ing({ name: "mushroom broth" })])).toEqual([true]);
  });

  it("uses matchedIngredientNames instead of namesOverlap when present", () => {
    const tracker = buildPantryRemainingTracker(
      [pantryItem({ name: "green onions" })],
      matchInfo({ 0: { matchedIngredientNames: new Set(["green onions"]) } }),
    );
    // namesOverlap alone would match "onion" too -- matchedIngredientNames restricts it.
    expect(pantryCoverage(tracker, [ing({ name: "onion" })])).toEqual([false]);
    expect(pantryCoverage(tracker, [ing({ name: "green onions" })])).toEqual([true]);
  });

  it("returns false once a quantified pool is fully depleted", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "chicken breast", amount: 450, unit: "g" })], new Map());
    commitPantryConsumption(tracker, [ing({ name: "chicken breast", metricAmount: 450, metricUnit: "g" })]);
    expect(pantryCoverage(tracker, [ing({ name: "chicken breast" })])).toEqual([false]);
  });

  it("never mutates the tracker", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "chicken breast", amount: 450, unit: "g" })], new Map());
    pantryCoverage(tracker, [ing({ name: "chicken breast", metricAmount: 450, metricUnit: "g" })]);
    pantryCoverage(tracker, [ing({ name: "chicken breast", metricAmount: 450, metricUnit: "g" })]);
    expect(tracker.pools[0].remainingBase).toBe(450);
  });
});

describe("commitPantryConsumption / releasePantryConsumption", () => {
  it("depletes a matched pool by the required amount", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "chicken breast", amount: 450, unit: "g" })], new Map());
    commitPantryConsumption(tracker, [ing({ name: "chicken breast", metricAmount: 200, metricUnit: "g" })]);
    expect(tracker.pools[0].remainingBase).toBe(250);
  });

  it("is an exact inverse, including when a commit drives remainingBase negative", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "chicken breast", amount: 100, unit: "g" })], new Map());
    const ingredients = [ing({ name: "chicken breast", metricAmount: 300, metricUnit: "g" })];
    commitPantryConsumption(tracker, ingredients);
    expect(tracker.pools[0].remainingBase).toBe(-200); // unclamped internally
    releasePantryConsumption(tracker, ingredients);
    expect(tracker.pools[0].remainingBase).toBe(100); // back to exactly where it started
  });

  it("never mutates an unlimited (unquantified) pool", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "chicken breast" })], new Map());
    commitPantryConsumption(tracker, [ing({ name: "chicken breast", metricAmount: 200, metricUnit: "g" })]);
    expect(tracker.pools[0].remainingBase).toBe(0);
    expect(tracker.pools[0].category).toBeNull();
  });

  it("sums multiple matching lines within one candidate into ONE required total, not applied per-line", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "garlic", amount: 5, unit: "cloves" })], new Map());
    const ingredients = [
      ing({ id: 1, name: "garlic", metricAmount: 2, metricUnit: "cloves" }),
      ing({ id: 2, name: "garlic", metricAmount: 1, metricUnit: "cloves" }),
    ];
    commitPantryConsumption(tracker, ingredients);
    // 5 - (2 + 1) = 2, not 5-2=3 then 5-1=4 applied independently.
    expect(tracker.pools[0].remainingBase).toBe(2);
  });

  it("lets two different pools independently deplete from the same candidate", () => {
    const tracker = buildPantryRemainingTracker(
      [pantryItem({ name: "chicken breast", amount: 300, unit: "g" }), pantryItem({ name: "white rice", amount: 200, unit: "g" })],
      new Map(),
    );
    const ingredients = [
      ing({ id: 1, name: "chicken breast", metricAmount: 100, metricUnit: "g" }),
      ing({ id: 2, name: "white rice", metricAmount: 150, metricUnit: "g" }),
    ];
    commitPantryConsumption(tracker, ingredients);
    expect(tracker.pools[0].remainingBase).toBe(200);
    expect(tracker.pools[1].remainingBase).toBe(50);
  });

  it("credits a cross-category match using a resolved conversion rate", () => {
    // Pantry: 500ml. Candidate ingredient: needs grams. Rate = 1g per 1ml.
    const tracker = buildPantryRemainingTracker(
      [pantryItem({ name: "greek yogurt", amount: 500, unit: "ml" })],
      matchInfo({ 0: { matchedIngredientNames: new Set(["greek yogurt"]), unitConversionRates: new Map([["g", 1]]) } }),
    );
    commitPantryConsumption(tracker, [ing({ name: "greek yogurt", metricAmount: 300, metricUnit: "g" })]);
    expect(tracker.pools[0].remainingBase).toBe(200); // 500ml - 300g@1g/ml = 200ml
  });

  it("matches by name but contributes nothing to required when no conversion rate is available (still not a crash)", () => {
    const tracker = buildPantryRemainingTracker(
      [pantryItem({ name: "greek yogurt", amount: 500, unit: "ml" })],
      matchInfo({ 0: { matchedIngredientNames: new Set(["greek yogurt"]) } }), // no unitConversionRates
    );
    commitPantryConsumption(tracker, [ing({ name: "greek yogurt", metricAmount: 300, metricUnit: "g" })]);
    expect(tracker.pools[0].remainingBase).toBe(500); // untouched -- matched, but unconvertible
  });
});

describe("buildTrackerFromKnownConsumption", () => {
  it("with no consumed lists, is identical to buildPantryRemainingTracker(items, new Map())", () => {
    const items = [pantryItem({ name: "chicken breast", amount: 450, unit: "g" })];
    const tracker = buildTrackerFromKnownConsumption(items, []);
    const baseline = buildPantryRemainingTracker(items, new Map());
    expect(tracker).toEqual(baseline);
  });

  it("depletes the matching pool by one consumed ingredient list", () => {
    const items = [pantryItem({ name: "chicken breast", amount: 450, unit: "g" })];
    const tracker = buildTrackerFromKnownConsumption(items, [
      [ing({ name: "chicken breast", metricAmount: 200, metricUnit: "g" })],
    ]);
    expect(tracker.pools[0].remainingBase).toBe(250);
  });

  it("accumulates depletion across multiple consumed lists (simulating several other plan slots)", () => {
    const items = [pantryItem({ name: "white rice", amount: 500, unit: "g" })];
    const tracker = buildTrackerFromKnownConsumption(items, [
      [ing({ name: "white rice", metricAmount: 100, metricUnit: "g" })],
      [ing({ name: "white rice", metricAmount: 150, metricUnit: "g" })],
      [ing({ name: "white rice", metricAmount: 50, metricUnit: "g" })],
    ]);
    expect(tracker.pools[0].remainingBase).toBe(200); // 500 - (100 + 150 + 50)
  });

  it("leaves an unlimited pool (no structured quantity) at category null, unaffected by consumption", () => {
    const items = [pantryItem({ name: "chicken breast" })];
    const tracker = buildTrackerFromKnownConsumption(items, [
      [ing({ name: "chicken breast", metricAmount: 999999, metricUnit: "g" })],
    ]);
    expect(tracker.pools[0].category).toBeNull();
    expect(pantryCoverage(tracker, [ing({ name: "chicken breast" })])).toEqual([true]);
  });

  it("leaves the tracker unchanged when a consumed list doesn't match any pool", () => {
    const items = [pantryItem({ name: "pea", amount: 10, unit: "g" })];
    const tracker = buildTrackerFromKnownConsumption(items, [
      [ing({ name: "peanut oil", metricAmount: 5, metricUnit: "g" })],
    ]);
    expect(tracker.pools[0].remainingBase).toBe(10);
  });
});

describe("three-tier degrade contract", () => {
  it("tier 1: no structured quantity -> unlimited, contributes coverage but never depletes", () => {
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "chicken breast" })], new Map());
    expect(pantryCoverage(tracker, [ing({ name: "chicken breast" })])).toEqual([true]);
    commitPantryConsumption(tracker, [ing({ name: "chicken breast", metricAmount: 999999, metricUnit: "g" })]);
    expect(pantryCoverage(tracker, [ing({ name: "chicken breast" })])).toEqual([true]); // still covered, never exhausted
  });

  it("tier 2: quantity given, resolution unavailable -> still boolean-only, same-category math still works", () => {
    // matchedIngredientNames null (unresolved) falls back to namesOverlap;
    // a same-category match still quantifies correctly even without any
    // LLM/API resolution, since same-category conversion needs no
    // external lookup at all -- only CROSS-category needs it.
    const tracker = buildPantryRemainingTracker([pantryItem({ name: "chicken breast", amount: 450, unit: "g" })], new Map());
    expect(pantryCoverage(tracker, [ing({ name: "boneless skinless chicken breast" })])).toEqual([true]);
  });

  it("tier 3: quantity given and resolved -> real depletion", () => {
    const tracker = buildPantryRemainingTracker(
      [pantryItem({ name: "chicken breast", amount: 450, unit: "g" })],
      matchInfo({ 0: { matchedIngredientNames: new Set(["chicken breast"]) } }),
    );
    commitPantryConsumption(tracker, [ing({ name: "chicken breast", metricAmount: 450, metricUnit: "g" })]);
    expect(pantryCoverage(tracker, [ing({ name: "chicken breast" })])).toEqual([false]);
  });
});
