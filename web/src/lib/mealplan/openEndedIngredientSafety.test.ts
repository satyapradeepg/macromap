import { describe, it, expect } from "vitest";
import { isOpenEndedIngredientUnsafeFor, anyIngredientUnsafeFor, type DietaryContext } from "./openEndedIngredientSafety";

const NONE: DietaryContext = { dietaryStyles: [], allergies: [], dislikes: [] };

describe("isOpenEndedIngredientUnsafeFor", () => {
  it("passes an ordinary ingredient with no restrictions", () => {
    expect(isOpenEndedIngredientUnsafeFor("seitan cutlets", NONE)).toBeNull();
  });

  describe("explicit allergy/dislike words", () => {
    it("catches a direct substring match", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["banana"] };
      expect(isOpenEndedIngredientUnsafeFor("banana", ctx)).not.toBeNull();
    });

    it("catches a category word via the synonym table even without a literal substring match", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["nuts"] };
      expect(isOpenEndedIngredientUnsafeFor("almond butter", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("cashews", ctx)).not.toBeNull();
    });

    it("catches hidden egg forms for an egg allergy", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["eggs"] };
      expect(isOpenEndedIngredientUnsafeFor("mayonnaise", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("hollandaise sauce", ctx)).not.toBeNull();
    });

    it("catches hidden fish forms (Worcestershire sauce) for a fish/seafood-adjacent concern", () => {
      // Worcestershire is tagged under NON_VEGETARIAN_KEYWORDS, exercised below.
      const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("worcestershire sauce", ctx)).not.toBeNull();
    });

    it("does not flag an unrelated ingredient", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["nuts"] };
      expect(isOpenEndedIngredientUnsafeFor("quinoa", ctx)).toBeNull();
    });
  });

  describe("dietary style", () => {
    it("flags meat/fish for vegetarian", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("grilled chicken breast", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("salmon fillet", ctx)).not.toBeNull();
    });

    it("does not flag dairy/eggs for a merely vegetarian profile", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("halloumi cheese", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("scrambled eggs", ctx)).toBeNull();
    });

    it("flags dairy/eggs/honey in addition to meat/fish for vegan", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("halloumi cheese", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("scrambled eggs", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("honey", ctx)).not.toBeNull();
    });

    it("does not flag a real vegan ingredient", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("seitan cutlets", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("black beans", ctx)).toBeNull();
    });
  });

  // dairy_free/gluten_free presets, added July 15 2026 (audit round 2) --
  // this gate previously only activated a category from literal free-text
  // allergy/dislike words, so these two first-class F2 dietary-style
  // presets never triggered it at all, the same gap found and fixed the
  // same day for the fixed-pool gate (ingredientSafety.ts).
  describe("dairy_free / gluten_free dietary-style presets", () => {
    it("flags dairy for a dairy_free profile with no explicit 'dairy' allergy/dislike text", () => {
      const ctx: DietaryContext = { dietaryStyles: ["dairy_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("halloumi cheese", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("whole milk", ctx)).not.toBeNull();
    });

    it("does not flag non-dairy ingredients for a dairy_free profile", () => {
      const ctx: DietaryContext = { dietaryStyles: ["dairy_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("quinoa", ctx)).toBeNull();
    });

    it("flags gluten (including seitan, a wheat-gluten product) for a gluten_free profile", () => {
      const ctx: DietaryContext = { dietaryStyles: ["gluten_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("seitan cutlets", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("whole wheat bread", ctx)).not.toBeNull();
    });

    it("does not apply the gluten_free check for an unrelated style like vegetarian", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("seitan cutlets", ctx)).toBeNull();
    });

    it("regression: dairy_free + gluten_free with no vegan style still blocks dairy and gluten -- mirrors the fixed-pool gate's regression test", () => {
      const ctx: DietaryContext = {
        dietaryStyles: ["dairy_free", "gluten_free"],
        allergies: ["tree nut", "shellfish"],
        dislikes: ["cilantro"],
      };
      expect(isOpenEndedIngredientUnsafeFor("halloumi cheese", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("seitan cutlets", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("grilled chicken breast", ctx)).toBeNull();
    });
  });
});

describe("anyIngredientUnsafeFor", () => {
  it("returns a reason if any ingredient in the list is unsafe", () => {
    const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
    const reason = anyIngredientUnsafeFor(["quinoa", "black beans", "grilled chicken breast"], ctx);
    expect(reason).not.toBeNull();
  });

  it("returns null when every ingredient passes", () => {
    const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: ["nuts"], dislikes: ["cilantro"] };
    expect(anyIngredientUnsafeFor(["quinoa", "black beans", "halloumi cheese", "avocado"], ctx)).toBeNull();
  });
});
