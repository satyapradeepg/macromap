import { describe, it, expect } from "vitest";
import { isKnownIngredientUnsafeFor, filterSafeIngredientNames, type DietaryContext } from "./ingredientSafety";
import { STATIC_INGREDIENT_MACROS } from "./staticIngredientMacros";

const NONE: DietaryContext = { dietaryStyles: [], allergies: [], dislikes: [] };

describe("isKnownIngredientUnsafeFor", () => {
  it("passes a known ingredient with no restrictions", () => {
    expect(isKnownIngredientUnsafeFor("greek yogurt", NONE)).toBeNull();
  });

  it("returns null (not flagged) for an ingredient outside the static table", () => {
    // This function is scoped to the known static 9 -- an unrecognized
    // name is a bug upstream in THIS fixed system, not a new food to
    // reason about, so null here is correct for this caller only.
    expect(isKnownIngredientUnsafeFor("dragon fruit", { ...NONE, allergies: ["dragon fruit"] })).toBeNull();
  });

  describe("explicit allergy presets", () => {
    it("flags every nut-tagged ingredient for a 'nuts' allergy", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["nuts"] };
      expect(isKnownIngredientUnsafeFor("almonds", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("walnuts", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("peanut butter", ctx)).not.toBeNull();
    });

    it("does not flag non-nut ingredients for a 'nuts' allergy", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["nuts"] };
      expect(isKnownIngredientUnsafeFor("greek yogurt", ctx)).toBeNull();
      expect(isKnownIngredientUnsafeFor("banana", ctx)).toBeNull();
    });

    it("flags soy-ambiguous protein powder for a 'soy' allergy but not other ingredients", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["soy"] };
      expect(isKnownIngredientUnsafeFor("protein powder", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("greek yogurt", ctx)).toBeNull();
    });
  });

  describe("free-text allergy/dislike synonyms", () => {
    it("catches 'dairy' typed as a free-text allergy even though it's not a literal substring of the ingredient name", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["dairy"] };
      expect(isKnownIngredientUnsafeFor("greek yogurt", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("cottage cheese", ctx)).not.toBeNull();
    });

    it("catches 'milk' as a dairy synonym", () => {
      const ctx: DietaryContext = { ...NONE, dislikes: ["milk"] };
      expect(isKnownIngredientUnsafeFor("cottage cheese", ctx)).not.toBeNull();
    });

    it("catches a direct substring dislike match", () => {
      const ctx: DietaryContext = { ...NONE, dislikes: ["banana"] };
      expect(isKnownIngredientUnsafeFor("banana", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("apple", ctx)).toBeNull();
    });
  });

  describe("dietary style", () => {
    it("flags every non-vegan-compliant ingredient for a vegan profile", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
      expect(isKnownIngredientUnsafeFor("greek yogurt", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("cottage cheese", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("protein powder", ctx)).not.toBeNull();
    });

    it("does not flag vegan-compliant ingredients for a vegan profile", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
      expect(isKnownIngredientUnsafeFor("banana", ctx)).toBeNull();
      expect(isKnownIngredientUnsafeFor("almonds", ctx)).toBeNull();
    });

    it("does not apply the vegan check for a merely vegetarian profile", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
      expect(isKnownIngredientUnsafeFor("greek yogurt", ctx)).toBeNull();
    });
  });

  describe("dairy_free / gluten_free dietary-style presets (audit round 2, July 15 2026)", () => {
    it("flags every dairy-tagged ingredient for a dairy_free profile with no explicit 'dairy' allergy/dislike text", () => {
      const ctx: DietaryContext = { dietaryStyles: ["dairy_free"], allergies: [], dislikes: [] };
      expect(isKnownIngredientUnsafeFor("greek yogurt", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("cottage cheese", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("protein powder", ctx)).not.toBeNull();
    });

    it("does not flag non-dairy ingredients for a dairy_free profile", () => {
      const ctx: DietaryContext = { dietaryStyles: ["dairy_free"], allergies: [], dislikes: [] };
      expect(isKnownIngredientUnsafeFor("banana", ctx)).toBeNull();
      expect(isKnownIngredientUnsafeFor("almonds", ctx)).toBeNull();
    });

    it("does not apply the dairy_free check for an unrelated style like vegetarian", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
      expect(isKnownIngredientUnsafeFor("greek yogurt", ctx)).toBeNull();
    });

    it("does not currently flag any pool ingredient for gluten_free -- none of the 9 contain gluten today, this locks in that expectation so it's caught if the pool ever changes", () => {
      const ctx: DietaryContext = { dietaryStyles: ["gluten_free"], allergies: [], dislikes: [] };
      for (const name of Object.keys(STATIC_INGREDIENT_MACROS)) {
        expect(isKnownIngredientUnsafeFor(name, ctx), name).toBeNull();
      }
    });

    it("regression: the pool-expansion additions (pea protein powder, hemp seeds, sunflower seed butter, chia seeds) all pass for vegan + nut allergy + soy allergy stacked", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: ["nuts", "soy"], dislikes: [] };
      expect(isKnownIngredientUnsafeFor("pea protein powder", ctx)).toBeNull();
      expect(isKnownIngredientUnsafeFor("hemp seeds", ctx)).toBeNull();
      expect(isKnownIngredientUnsafeFor("sunflower seed butter", ctx)).toBeNull();
      expect(isKnownIngredientUnsafeFor("chia seeds", ctx)).toBeNull();
    });

    it("regression: dairy_free + gluten_free with no vegan style still blocks dairy pool items -- the exact combination that served cottage cheese/greek yogurt live on July 15 2026", () => {
      const ctx: DietaryContext = {
        dietaryStyles: ["dairy_free", "gluten_free"],
        allergies: ["tree nut", "shellfish"],
        dislikes: ["cilantro"],
      };
      expect(isKnownIngredientUnsafeFor("cottage cheese", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("greek yogurt", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("protein powder", ctx)).not.toBeNull();
      expect(isKnownIngredientUnsafeFor("banana", ctx)).toBeNull();
    });
  });
});

// Audit round 3 (July 15 2026): the same word-boundary bug already fixed
// in the sibling open-ended gate (openEndedIngredientSafety.ts) existed
// here too, in both mentionsAny's bare substring check and the direct
// userWord-vs-ingredientKey check.
describe("word-boundary false-positive fixes (audit round 3, July 15 2026)", () => {
  it("does not flag 'nutmeg' or 'donut' as a nut allergy match", () => {
    const nutmegCtx: DietaryContext = { ...NONE, dislikes: ["nutmeg"] };
    expect(isKnownIngredientUnsafeFor("almonds", nutmegCtx)).toBeNull();
    expect(isKnownIngredientUnsafeFor("walnuts", nutmegCtx)).toBeNull();
    expect(isKnownIngredientUnsafeFor("peanut butter", nutmegCtx)).toBeNull();

    const donutCtx: DietaryContext = { ...NONE, dislikes: ["donut"] };
    expect(isKnownIngredientUnsafeFor("almonds", donutCtx)).toBeNull();
  });

  it("still catches a genuine 'nut'/'nuts' dislike via mentionsAny", () => {
    const ctx: DietaryContext = { ...NONE, dislikes: ["nut"] };
    expect(isKnownIngredientUnsafeFor("almonds", ctx)).not.toBeNull();
  });
});

describe("filterSafeIngredientNames", () => {
  it("removes every nut-tagged ingredient for a nut allergy, keeps the rest", () => {
    const ctx: DietaryContext = { ...NONE, allergies: ["nuts"] };
    const names = ["greek yogurt", "banana", "almonds", "peanut butter", "walnuts", "orange"];
    const safe = filterSafeIngredientNames(names, ctx);
    expect(safe).toEqual(["greek yogurt", "banana", "orange"]);
  });

  it("returns everything unfiltered when there are no restrictions", () => {
    const names = ["greek yogurt", "almonds", "banana"];
    expect(filterSafeIngredientNames(names, NONE)).toEqual(names);
  });
});
