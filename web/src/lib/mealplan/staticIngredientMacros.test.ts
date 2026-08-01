import { describe, it, expect } from "vitest";
import { STATIC_INGREDIENT_MACROS, lookupIngredientMacrosStatic, prepNoteFor } from "./staticIngredientMacros";
import { allPoolIngredientNames } from "./snackComposition";
import { ADDON_INGREDIENT_OPTIONS_BY_MACRO } from "./addon";

describe("staticIngredientMacros", () => {
  it("covers every name in the snack composition pool", () => {
    for (const name of allPoolIngredientNames()) {
      expect(lookupIngredientMacrosStatic(name)).not.toBeNull();
    }
  });

  it("covers every name addon.ts maps a macro gap to", () => {
    for (const names of Object.values(ADDON_INGREDIENT_OPTIONS_BY_MACRO)) {
      for (const name of names) {
        expect(lookupIngredientMacrosStatic(name)).not.toBeNull();
      }
    }
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(lookupIngredientMacrosStatic("Greek Yogurt")).toEqual(STATIC_INGREDIENT_MACROS["greek yogurt"]);
    expect(lookupIngredientMacrosStatic("  banana  ")).toEqual(STATIC_INGREDIENT_MACROS.banana);
  });

  it("returns null for an unrecognized ingredient", () => {
    expect(lookupIngredientMacrosStatic("dragon fruit")).toBeNull();
  });

  it("every entry has plausible positive macro values", () => {
    for (const [name, entry] of Object.entries(STATIC_INGREDIENT_MACROS)) {
      expect(entry.caloriesPer100g, name).toBeGreaterThan(0);
      expect(entry.proteinGPer100g, name).toBeGreaterThanOrEqual(0);
      expect(entry.carbsGPer100g, name).toBeGreaterThanOrEqual(0);
      expect(entry.fatGPer100g, name).toBeGreaterThanOrEqual(0);
      expect(entry.id, name).toBeGreaterThan(0);
    }
  });
});

describe("prepNoteFor", () => {
  it("returns null for ingredients that are fine eaten as-is", () => {
    for (const name of ["greek yogurt", "cottage cheese", "banana", "apple", "orange", "almonds", "peanut butter", "walnuts", "sunflower seed butter", "dates", "pumpkin seeds"]) {
      expect(prepNoteFor(name, "snack", ["oats"])).toBeNull();
      expect(prepNoteFor(name, "addon", [])).toBeNull();
    }
  });

  // 2026-07-30: oats/edamame both need real prep (cooking) before they're
  // actually eaten in the sized raw amount -- same "isn't standalone" gap
  // as protein powder above, missed for edamame until asked directly
  // whether people actually snack on it.
  it("tells oats to cook as oatmeal and edamame to steam/boil, both zero extra macros", () => {
    expect(prepNoteFor("oats", "snack", ["hemp seeds"])).toBe("cook with water as oatmeal");
    expect(prepNoteFor("edamame", "snack", ["almonds"])).toBe("steam or boil a few minutes");
  });

  it("tells protein powders to mix with water only, never milk (milk carries untracked macros)", () => {
    for (const name of ["protein powder", "pea protein powder"]) {
      expect(prepNoteFor(name, "addon", [])).toBe("mix with water");
      expect(prepNoteFor(name, "snack", ["banana"])).toBe("mix with water");
      expect(prepNoteFor(name, "snack", [])).toBe("mix with water");
    }
  });

  // 2026-07-30: names the actual other ingredient(s) instead of the vague
  // "the rest of this snack" -- with oats/edamame in the pool, a snack can
  // have exactly one other named ingredient, not an ambiguous remainder
  // (the real bug this replaces: "15g hemp seeds + 10g oats" rendering as
  // "sprinkle over the rest of this snack", which also silently swallowed
  // oats' own "cook with water as oatmeal" note in the old one-note footer).
  it("points chia/hemp seeds at the actual other ingredient(s), not a vague 'rest of this snack'", () => {
    for (const name of ["chia seeds", "hemp seeds"]) {
      expect(prepNoteFor(name, "addon", [])).toBe("sprinkle over your meal");
      expect(prepNoteFor(name, "snack", ["oats"])).toBe("sprinkle over the oats");
      expect(prepNoteFor(name, "snack", ["oats", "almonds"])).toBe("sprinkle over the oats and almonds");
    }
  });

  it("gives an honest, macro-accurate note when seeds are the ONLY ingredient in a snack", () => {
    // Chia genuinely gels in plain water (real chia-pudding prep, zero extra macros).
    expect(prepNoteFor("chia seeds", "snack", [])).toBe("soak in water");
    // Hemp seeds have no equivalent zero-macro standalone prep -- doesn't
    // pretend one exists rather than silently suggesting an untracked pairing.
    expect(prepNoteFor("hemp seeds", "snack", [])).toBe("best paired with a meal you're already having");
  });

  it("is case-insensitive and trims whitespace, same as lookupIngredientMacrosStatic", () => {
    expect(prepNoteFor("Protein Powder", "addon", [])).toBe("mix with water");
    expect(prepNoteFor("  chia seeds  ", "addon", [])).toBe("sprinkle over your meal");
  });

  it("returns null for an unrecognized ingredient", () => {
    expect(prepNoteFor("dragon fruit", "snack", ["oats"])).toBeNull();
  });
});
