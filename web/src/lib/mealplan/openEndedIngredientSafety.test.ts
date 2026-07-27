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

  // Comprehensive engine test, July 16 2026: category activation used to
  // require the user's ENTIRE free-text word to equal a bare keyword like
  // "shellfish" -- a natural phrasing like "shellfish allergy" silently
  // disabled the whole synonym-category system for that word.
  describe("natural-phrase free-text allergies (comprehensive engine test, July 16 2026)", () => {
    it("catches a category via a natural allergy phrase, not just the bare keyword", () => {
      const shellfishCtx: DietaryContext = { ...NONE, allergies: ["shellfish allergy"] };
      expect(isOpenEndedIngredientUnsafeFor("grilled shrimp skewers", shellfishCtx)).not.toBeNull();

      const peanutCtx: DietaryContext = { ...NONE, allergies: ["peanut allergy"] };
      expect(isOpenEndedIngredientUnsafeFor("peanut sauce noodles", peanutCtx)).not.toBeNull();

      const sesameCtx: DietaryContext = { ...NONE, allergies: ["allergic to sesame"] };
      expect(isOpenEndedIngredientUnsafeFor("tahini", sesameCtx)).not.toBeNull();
    });

    it("still does not false-positive on a word that merely contains the keyword as a substring, not a whole word", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["nutmeg allergy"] };
      expect(isOpenEndedIngredientUnsafeFor("almonds", ctx)).toBeNull();
    });

    it("does not let a 'peanut butter' or 'coconut milk' allergy activate the dairy category", () => {
      const peanutButterCtx: DietaryContext = { ...NONE, allergies: ["peanut butter"] };
      expect(isOpenEndedIngredientUnsafeFor("whole milk", peanutButterCtx)).toBeNull();
      // The nut category should still correctly trigger for the same word.
      expect(isOpenEndedIngredientUnsafeFor("almond cake", peanutButterCtx)).not.toBeNull();

      const coconutMilkCtx: DietaryContext = { ...NONE, allergies: ["coconut milk"] };
      expect(isOpenEndedIngredientUnsafeFor("whole milk", coconutMilkCtx)).toBeNull();
    });
  });

  // Dimension-5 dislike stress test, July 20 2026: category expansion
  // (the SYNONYM_GROUPS loop) used to check allergies+dislikes combined --
  // a free-text DISLIKE of "blue cheese" matched "cheese" in DAIRY_SYNONYMS
  // and activated the whole dairy category, rejecting an AI-composed
  // yogurt breakfast for a user who never said anything about dairy in
  // general. Live-reproduced via a 6-dislike stress profile (3 breakfast
  // slots stayed blocked because of this). Category expansion is now
  // allergy/dietary-style ONLY; a dislike only ever earns a direct match.
  describe("dislikes no longer conflate with allergies for category-wide exclusion (2026-07-20)", () => {
    it("a 'blue cheese' dislike does not exclude yogurt/milk/other dairy", () => {
      const ctx: DietaryContext = { ...NONE, dislikes: ["blue cheese"] };
      expect(isOpenEndedIngredientUnsafeFor("plain nonfat greek yogurt", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("whole milk", ctx)).toBeNull();
    });

    it("an actual 'dairy'/'milk' allergy still excludes the whole category", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["dairy"] };
      expect(isOpenEndedIngredientUnsafeFor("plain nonfat greek yogurt", ctx)).not.toBeNull();
    });

    it("a dislike still directly blocks an ingredient literally named after it", () => {
      const ctx: DietaryContext = { ...NONE, dislikes: ["greek yogurt"] };
      expect(isOpenEndedIngredientUnsafeFor("plain nonfat greek yogurt", ctx)).not.toBeNull();
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

  // Regression tests for real false positives found live July 15 2026
  // while investigating a genuine recipe-search diet-compliance gap
  // (Spoonacular's own diet=vegetarian/vegan tag can be wrong -- see the
  // real-recipe tests below). Fixing THIS module's substring matching was
  // a prerequisite for safely reusing it on real recipe ingredient text,
  // which has far more variety than the LLM-proposal text it originally
  // covered.
  describe("word-boundary false-positive fixes (audit round 3, July 15 2026)", () => {
    it("does not flag 'eggplant' or 'veggie' for an egg allergy/vegan diet", () => {
      const allergyCtx: DietaryContext = { ...NONE, allergies: ["eggs"] };
      expect(isOpenEndedIngredientUnsafeFor("eggplant parmesan", allergyCtx)).toBeNull();
      const veganCtx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("eggplant", veganCtx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("veggie scramble", veganCtx)).toBeNull();
    });

    it("does not flag 'coconut', 'butternut squash', or 'nutmeg' for a nut allergy", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["nuts"] };
      expect(isOpenEndedIngredientUnsafeFor("coconut milk", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("butternut squash", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("nutmeg", ctx)).toBeNull();
    });

    it("does not flag 'buckwheat' for a gluten_free profile", () => {
      const ctx: DietaryContext = { dietaryStyles: ["gluten_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("buckwheat flour", ctx)).not.toBeNull(); // "flour" itself is still flagged
      expect(isOpenEndedIngredientUnsafeFor("buckwheat", ctx)).toBeNull(); // but "buckwheat" alone is not wheat
    });

    it("does not flag plant-milk/plant-butter compounds for vegan/dairy_free", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("coconut milk", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("almond milk", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("oat milk", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("peanut butter", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("almond butter", ctx)).toBeNull();
    });

    it("does not flag a comma-reordered plant-milk/plant-butter name (audit item #2, 2026-07-21)", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("milk, coconut", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("butter, almond", ctx)).toBeNull();
    });

    it("still flags real dairy milk/butter/cream for vegan, not just the plant-based compounds", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("whole milk", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("milk", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("unsalted butter", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("heavy cream", ctx)).not.toBeNull();
    });

    it("still catches plural nut forms (cashews, almonds, walnuts) -- regression check for the word-boundary fix itself", () => {
      const ctx: DietaryContext = { ...NONE, allergies: ["nuts"] };
      expect(isOpenEndedIngredientUnsafeFor("cashews", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("almonds", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("chopped walnuts", ctx)).not.toBeNull();
    });

    // Live-confirmed miss, 2026-07-27: a free-text dislike typed as a plain
    // plural ("mushrooms") built the regex \bmushroomss?\b, which can never
    // match a singular real-recipe occurrence ("cream of mushroom soup") --
    // opposite direction from the case above (plural allergy word vs.
    // plural ingredient form). wordBoundaryIncludes now stems the needle's
    // own trailing "s" before re-appending it, so both directions match.
    it("catches a singular ingredient occurrence for a plural free-text dislike", () => {
      const ctx: DietaryContext = { ...NONE, dislikes: ["mushrooms"] };
      expect(isOpenEndedIngredientUnsafeFor("campbell's cream of mushroom soup", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("mushroom", ctx)).not.toBeNull();
    });

    it("still catches the real live-confirmed violation: chicken broth in a vegetarian-tagged recipe", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("chicken broth", ctx)).not.toBeNull();
    });

    it("does not flag vegetable or mushroom broth/stock for vegetarian", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("vegetable broth", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("mushroom broth", ctx)).toBeNull();
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

    it("does not flag an ingredient explicitly labeled gluten-free (audit fix, 2026-07-21 stacked-safety investigation)", () => {
      // Live-confirmed: "gluten-free rolled oats" and "rolled oats
      // (gluten-free)" both got flagged unsafe -- the bare word-boundary
      // match for "gluten" fired on the literal word inside the
      // ingredient's OWN "gluten-free" qualifier, punishing exactly the
      // case where the ingredient correctly calls out that an otherwise-
      // risky food (oats are commonly cross-contaminated) has been
      // screened.
      const ctx: DietaryContext = { dietaryStyles: ["gluten_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("gluten-free rolled oats", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("rolled oats (gluten-free)", ctx)).toBeNull();
    });

    it("still flags an actually-contradictory 'gluten-free seitan' label -- the exemption only covers the word 'gluten' itself", () => {
      const ctx: DietaryContext = { dietaryStyles: ["gluten_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("gluten-free seitan", ctx)).not.toBeNull();
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

// Audit round 3 (July 15 2026): fish and sesame previously had zero
// synonym coverage -- a declared "fish" allergy never matched any actual
// fish, and sesame wasn't offered as a preset or covered by any group.
describe("fish and sesame allergy coverage (audit round 3, July 15 2026)", () => {
  it("catches specific fish for a 'fish' allergy, including a compound word (catfish)", () => {
    const ctx: DietaryContext = { ...NONE, allergies: ["fish"] };
    expect(isOpenEndedIngredientUnsafeFor("grilled salmon", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("tuna steak", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("catfish fillet", ctx)).not.toBeNull();
  });

  it("catches hidden fish forms (dashi, bonito, fish sauce) for a 'fish' allergy", () => {
    const ctx: DietaryContext = { ...NONE, allergies: ["fish"] };
    expect(isOpenEndedIngredientUnsafeFor("dashi broth", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("bonito flakes", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("fish sauce", ctx)).not.toBeNull();
  });

  it("catches sesame including tahini, which contains no literal substring 'sesame'", () => {
    const ctx: DietaryContext = { ...NONE, allergies: ["sesame"] };
    expect(isOpenEndedIngredientUnsafeFor("tahini", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("sesame oil", ctx)).not.toBeNull();
  });

  it("does not flag unrelated ingredients for fish/sesame allergies", () => {
    const fishCtx: DietaryContext = { ...NONE, allergies: ["fish"] };
    expect(isOpenEndedIngredientUnsafeFor("quinoa", fishCtx)).toBeNull();
    const sesameCtx: DietaryContext = { ...NONE, allergies: ["sesame"] };
    expect(isOpenEndedIngredientUnsafeFor("black beans", sesameCtx)).toBeNull();
  });
});

// Audit round 3: dairy/soy/gluten synonym lists missed common derivative
// forms, and NON_VEGETARIAN_KEYWORDS missed large common categories.
describe("synonym and vegetarian/vegan keyword completeness (audit round 3, July 15 2026)", () => {
  it("catches soy derivative forms (miso, natto) for a soy allergy", () => {
    const ctx: DietaryContext = { ...NONE, allergies: ["soy"] };
    expect(isOpenEndedIngredientUnsafeFor("miso soup", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("natto", ctx)).not.toBeNull();
  });

  it("catches gluten derivative forms (farro, udon) for a gluten_free profile", () => {
    const ctx: DietaryContext = { dietaryStyles: ["gluten_free"], allergies: [], dislikes: [] };
    expect(isOpenEndedIngredientUnsafeFor("farro salad", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("udon noodles", ctx)).not.toBeNull();
  });

  it("catches dairy derivative forms (paneer, ghee) for a dairy_free profile", () => {
    const ctx: DietaryContext = { dietaryStyles: ["dairy_free"], allergies: [], dislikes: [] };
    expect(isOpenEndedIngredientUnsafeFor("paneer tikka", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("ghee rice", ctx)).not.toBeNull();
  });

  it("flags previously-missed common non-vegetarian ingredients", () => {
    const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
    expect(isOpenEndedIngredientUnsafeFor("seared scallops", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("goat curry", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("chorizo hash", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("prosciutto-wrapped melon", ctx)).not.toBeNull();
  });

  it("flags bare shellfish/mollusk terms for vegan/vegetarian even with no declared shellfish allergy", () => {
    const ctx: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
    expect(isOpenEndedIngredientUnsafeFor("chowder with clams and mussels", ctx)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("grilled oysters", ctx)).not.toBeNull();
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
