import { describe, it, expect } from "vitest";
import {
  isOpenEndedIngredientUnsafeFor,
  anyIngredientUnsafeFor,
  isRecipeTitleUnsafeFor,
  dietaryStyleExcludeKeywords,
  condimentRiskWarnings,
  type DietaryContext,
} from "./openEndedIngredientSafety";

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

    // Pre-existing false positive, found 2026-07-27 while live-validating
    // the title check below against a real ~640-recipe Spoonacular sample:
    // "goat" is in NON_VEGETARIAN_KEYWORDS (real goat meat), but "goat
    // cheese"/"goat milk" are completely ordinary vegetarian dairy
    // products -- the same false-positive shape as "coconut milk" vs the
    // DAIRY_SYNONYMS "milk" check, just not yet given the equivalent
    // exception. Not introduced by anything in this session; found
    // incidentally, fixed here since it's the same mechanism.
    it("does not flag goat cheese/milk as non-vegetarian (goat-as-dairy-source, not goat meat)", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("goat cheese", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("fresh goat milk", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("goat yogurt", ctx)).toBeNull();
    });

    it("still flags real goat meat, not just any 'goat' occurrence", () => {
      const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("roasted goat leg", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("goat stew meat", ctx)).not.toBeNull();
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

    it("does not flag an ingredient explicitly labeled non-dairy (live-confirmed 2026-08-09 false positive)", () => {
      // Live-confirmed: adding an unrelated safe ingredient to a meal that
      // already contained "non-dairy beverage" got refused for a dairy_free
      // profile -- the bare word-boundary match for "dairy" fired on the
      // literal word inside the ingredient's OWN "non-dairy" qualifier,
      // the exact opposite of what that label means for this profile.
      const ctx: DietaryContext = { dietaryStyles: ["dairy_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("non-dairy beverage", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("nondairy creamer", ctx)).toBeNull();
    });

    // CORRECTED 2026-08-09: this test previously asserted "dairy-free
    // yogurt alternative" should still flag, reasoning it was the same
    // shape as "gluten-free seitan" (a word that's never itself negated).
    // That reasoning turned out to be wrong -- confirmed while
    // investigating a live "gluten-free brown rice pasta" false positive,
    // which surfaced the same gap for "pasta"/"bread"/"flour" (gluten),
    // and by extension "cheese"/"yogurt"/"butter"/"cream"/"milk" (dairy):
    // unlike seitan (which IS wheat gluten, full stop, no such thing as a
    // genuinely gluten-free seitan), yogurt/cheese/butter/cream/milk are
    // FOOD CATEGORIES that really do have both a dairy and a dairy-free
    // version on real shelves -- "dairy-free yogurt" is a real, common
    // product, not a contradiction. See hasCategoryLabelExemption.
    it("does not flag a food-category word with a genuine dairy-free version, when the category's own core term is negated in the same name", () => {
      const ctx: DietaryContext = { dietaryStyles: ["dairy_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("dairy-free yogurt alternative", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("dairy-free cheese shreds", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("dairy-free butter", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("dairy-free cream", ctx)).toBeNull();
    });

    it("still flags a plain dairy product with no dairy-free qualifier anywhere in the name", () => {
      const ctx: DietaryContext = { dietaryStyles: ["dairy_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("plain yogurt", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("cheddar cheese", ctx)).not.toBeNull();
    });

    it("still flags a real dairy allergy typed as literal free text, unaffected by the negation exemption", () => {
      const ctx: DietaryContext = { dietaryStyles: [], allergies: ["dairy"], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("whole milk", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("non-dairy beverage", ctx)).toBeNull();
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

    // Live-confirmed 2026-08-09: a real chat request to add "whole wheat
    // pasta" for a gluten_free profile got correctly self-censored by the
    // LLM proposer, which substituted "gluten-free brown rice pasta" --
    // but the safety gate then wrongly blocked its OWN safe substitute,
    // because the matched word was "pasta" (a GLUTEN_SYNONYMS proxy),
    // never itself negated by the "gluten-free" qualifier elsewhere in
    // the name. Unlike seitan (always wheat gluten, no exception),
    // bread/pasta/flour/couscous are food categories with genuine
    // gluten-free versions on real shelves.
    it("does not flag a food-category word with a genuine gluten-free version, when 'gluten' is negated in the same name (live-confirmed 2026-08-09)", () => {
      const ctx: DietaryContext = { dietaryStyles: ["gluten_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("gluten-free brown rice pasta", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("gluten-free bread", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("gluten-free all-purpose flour", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("gluten-free couscous", ctx)).toBeNull();
    });

    it("still flags bread/pasta/flour/couscous with no gluten-free qualifier anywhere in the name", () => {
      const ctx: DietaryContext = { dietaryStyles: ["gluten_free"], allergies: [], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("whole wheat bread", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("penne pasta", ctx)).not.toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("all-purpose flour", ctx)).not.toBeNull();
    });

    it("does not flag egg-free mayonnaise/aioli/custard for an egg allergy (same category-label exemption, egg group)", () => {
      const ctx: DietaryContext = { dietaryStyles: [], allergies: ["egg"], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("egg-free mayonnaise", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("egg-free aioli", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("egg-free custard", ctx)).toBeNull();
      // hollandaise has no common egg-free version and isn't in the
      // exemptable list -- still flags even with no qualifier present.
      expect(isOpenEndedIngredientUnsafeFor("hollandaise sauce", ctx)).not.toBeNull();
    });

    it("does not flag fish-free worcestershire sauce for a fish allergy (category-label exemption, fish group)", () => {
      const ctx: DietaryContext = { dietaryStyles: [], allergies: ["fish"], dislikes: [] };
      expect(isOpenEndedIngredientUnsafeFor("fish-free worcestershire sauce", ctx)).toBeNull();
      expect(isOpenEndedIngredientUnsafeFor("worcestershire sauce", ctx)).not.toBeNull();
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

// Persona audit 2026-07-31, live diet-filter test: bare "beef" doesn't catch
// a recipe/title naming only the specific cut ("flank steak," "pot roast")
// with no separate "beef"/"meat" word anywhere -- 3 real Spoonacular
// recipes would have slipped past unflagged. Deliberately fully-qualified
// cut names, not bare "steak"/"roast" (see NON_VEGETARIAN_KEYWORDS's own
// comment for why those two bare words are NOT added -- real collision
// risk with "cauliflower steak"/"roasted vegetables").
describe("beef-cut/roast compounds (persona audit follow-up, 2026-07-31)", () => {
  const VEGETARIAN: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };

  it("catches the exact real recipe titles/ingredients that slipped through live", () => {
    expect(isRecipeTitleUnsafeFor("Marinated Flat Iron Steak", VEGETARIAN)).not.toBeNull();
    expect(isRecipeTitleUnsafeFor("Spinach and Gorgonzola Stuffed Flank Steak", VEGETARIAN)).not.toBeNull();
    expect(isRecipeTitleUnsafeFor("Instant Pot Pressure Cooker Pot Roast", VEGETARIAN)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("flank steak", VEGETARIAN)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("flat iron steak", VEGETARIAN)).not.toBeNull();
  });

  it("catches other common beef-cut and roast compounds", () => {
    expect(isOpenEndedIngredientUnsafeFor("sirloin steak", VEGETARIAN)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("ribeye steak", VEGETARIAN)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("roast beef sandwich", VEGETARIAN)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("chuck roast", VEGETARIAN)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("prime rib", VEGETARIAN)).not.toBeNull();
  });

  it("does NOT flag a vegetable dish using the same 'steak'/'roasted' naming convention", () => {
    // These are real, common vegetarian dish names -- bare "steak"/"roast"
    // are deliberately NOT keywords for exactly this reason.
    expect(isOpenEndedIngredientUnsafeFor("cauliflower steak", VEGETARIAN)).toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("portobello steak", VEGETARIAN)).toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("roasted red peppers", VEGETARIAN)).toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("roasted vegetables", VEGETARIAN)).toBeNull();
    expect(isRecipeTitleUnsafeFor("Cauliflower Steak with Chimichurri", VEGETARIAN)).toBeNull();
  });
});

// Live-confirmed 2026-07-31 (persona audit): a "halal" profile got pork
// (ham hocks, salt pork) and white wine served across a real generated
// week -- halal/kosher had zero keyword coverage anywhere before this.
describe("halal/kosher keyword enforcement (persona audit, 2026-07-31)", () => {
  const HALAL: DietaryContext = { dietaryStyles: ["halal"], allergies: [], dislikes: [] };
  const KOSHER: DietaryContext = { dietaryStyles: ["kosher"], allergies: [], dislikes: [] };

  it("catches the exact real violations found live: ham hocks, salt pork, white wine", () => {
    expect(isOpenEndedIngredientUnsafeFor("ham hocks", HALAL)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("salt pork", HALAL)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("white wine", HALAL)).not.toBeNull();
  });

  it("catches pork and shellfish for kosher", () => {
    expect(isOpenEndedIngredientUnsafeFor("bacon", KOSHER)).not.toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("shrimp", KOSHER)).not.toBeNull();
  });

  it("does not flag alcohol for kosher (not part of the checkable subset) or shellfish for halal", () => {
    expect(isOpenEndedIngredientUnsafeFor("white wine", KOSHER)).toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("shrimp", HALAL)).toBeNull();
  });

  it("does not flag anything when neither style is set", () => {
    expect(isOpenEndedIngredientUnsafeFor("ham hocks", NONE)).toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("white wine", NONE)).toBeNull();
  });

  it("does not false-positive on non-alcoholic 'beer' and 'wine' compounds", () => {
    expect(isOpenEndedIngredientUnsafeFor("root beer", HALAL)).toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("ginger beer", HALAL)).toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("red wine vinegar", HALAL)).toBeNull();
  });

  it("does not false-positive on an unrelated ordinary ingredient", () => {
    expect(isOpenEndedIngredientUnsafeFor("chickpeas", HALAL)).toBeNull();
    expect(isOpenEndedIngredientUnsafeFor("chickpeas", KOSHER)).toBeNull();
  });
});

describe("dietaryStyleExcludeKeywords", () => {
  it("returns pork + alcohol words for halal", () => {
    const words = dietaryStyleExcludeKeywords(["halal"]);
    expect(words).toContain("pork");
    expect(words).toContain("wine");
    expect(words).not.toContain("shrimp");
  });

  it("returns pork + shellfish words for kosher", () => {
    const words = dietaryStyleExcludeKeywords(["kosher"]);
    expect(words).toContain("pork");
    expect(words).toContain("shrimp");
    expect(words).not.toContain("wine");
  });

  it("de-duplicates pork appearing in both when both styles are set", () => {
    const words = dietaryStyleExcludeKeywords(["halal", "kosher"]);
    expect(words.filter((w) => w === "pork")).toHaveLength(1);
    expect(words).toContain("wine");
    expect(words).toContain("shrimp");
  });

  it("returns an empty list when neither style is set", () => {
    expect(dietaryStyleExcludeKeywords(["vegetarian"])).toEqual([]);
    expect(dietaryStyleExcludeKeywords([])).toEqual([]);
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

// Added 2026-07-27: closes a real, live-confirmed gap the ingredient-name
// check above cannot see -- Spoonacular's own structured ingredient data
// can be incomplete relative to what a recipe's TITLE names. Live-
// verified against a real ~640-recipe Spoonacular sample (3 real
// mistagged-vegetarian recipes found, 0 false positives observed) before
// building this -- see the exact titles/ingredient lists reproduced below.
describe("isRecipeTitleUnsafeFor", () => {
  const VEGETARIAN: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
  const VEGAN: DietaryContext = { dietaryStyles: ["vegan"], allergies: [], dislikes: [] };
  const NO_RESTRICTION: DietaryContext = { dietaryStyles: [], allergies: [], dislikes: [] };

  it("catches the real recipe that motivated this check: title says ham, real ingredients never mention it", () => {
    // Live Spoonacular data: extendedIngredients was exactly [sprouted
    // wheat bread, swiss cheese, mushroom, kale, thyme, dijon mustard] --
    // zero mention of ham -- so anyIngredientUnsafeFor alone passed this.
    expect(isRecipeTitleUnsafeFor("Ham and Swiss Panini With Mushrooms and Kale", VEGETARIAN)).not.toBeNull();
  });

  it("catches 2 more real Spoonacular mistagged-vegetarian recipes found in the same live sample", () => {
    expect(isRecipeTitleUnsafeFor("Broccoli Rabe and Breaded Veal Scallopini", VEGETARIAN)).not.toBeNull();
    expect(isRecipeTitleUnsafeFor("Mussels & Clams in White Wine {Cozze e Vongole}", VEGETARIAN)).not.toBeNull();
  });

  it("does not flag anything when no vegetarian/vegan style is set", () => {
    expect(isRecipeTitleUnsafeFor("Ham and Swiss Panini", NO_RESTRICTION)).toBeNull();
  });

  it("exempts a meat-analogue-branded title (the failure mode a past session rejected title-scanning over)", () => {
    expect(isRecipeTitleUnsafeFor("Vegan Chicken Nuggets", VEGETARIAN)).toBeNull();
    expect(isRecipeTitleUnsafeFor("Meatless Bacon BLT", VEGETARIAN)).toBeNull();
    expect(isRecipeTitleUnsafeFor("Plant-Based Beef Tacos", VEGAN)).toBeNull();
    expect(isRecipeTitleUnsafeFor("Mock Duck Stir Fry", VEGETARIAN)).toBeNull();
  });

  it("exempts a real plant/fungus species that shares a name with meat", () => {
    expect(isRecipeTitleUnsafeFor("Chicken of the Woods Mushroom Stir Fry", VEGETARIAN)).toBeNull();
    expect(isRecipeTitleUnsafeFor("Hen of the Woods with Garlic Butter", VEGETARIAN)).toBeNull();
  });

  it("exempts goat cheese/milk in a title, same fix as the ingredient-level check above", () => {
    expect(isRecipeTitleUnsafeFor("Vegetable Tart With Goat Cheese", VEGETARIAN)).toBeNull();
    expect(isRecipeTitleUnsafeFor("Herbed Goat Cheese Yogurt Dip w. Caramelized Onions", VEGETARIAN)).toBeNull();
  });

  it("does not over-exempt a genuinely mixed dish just because it also names a plant ingredient", () => {
    // Real Spoonacular recipe: genuinely contains real bacon alongside
    // tofu -- the qualifier exception must not treat "tofu" in the title
    // as if it were a "meatless"/"vegan" qualifier for "bacon".
    expect(isRecipeTitleUnsafeFor("Bacon Wrapped Tofu Tacos", VEGETARIAN)).not.toBeNull();
  });

  it("flags dairy/eggs/honey in a title for vegan but not for merely vegetarian", () => {
    expect(isRecipeTitleUnsafeFor("Honey Glazed Carrots", VEGAN)).not.toBeNull();
    expect(isRecipeTitleUnsafeFor("Honey Glazed Carrots", VEGETARIAN)).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(isRecipeTitleUnsafeFor("HAM AND SWISS PANINI", VEGETARIAN)).not.toBeNull();
    expect(isRecipeTitleUnsafeFor("vegan CHICKEN nuggets", VEGETARIAN)).toBeNull();
  });

  it("catches the exact real recipe title that slipped through live (2026-07-31 persona audit)", () => {
    const HALAL: DietaryContext = { dietaryStyles: ["halal"], allergies: [], dislikes: [] };
    expect(isRecipeTitleUnsafeFor("Cassoulet for 10", HALAL)).toBeNull(); // title alone names nothing unsafe -- confirms this needs the ingredient-level check, not a title-only gap
    expect(isRecipeTitleUnsafeFor("Chicken Farfalle with Low-Fat Alfredo Sauce", HALAL)).toBeNull(); // same -- "white wine" was in the ingredient list, not the title
  });

  it("catches pork/alcohol named directly in a title for halal, and pork/shellfish for kosher", () => {
    const HALAL: DietaryContext = { dietaryStyles: ["halal"], allergies: [], dislikes: [] };
    const KOSHER: DietaryContext = { dietaryStyles: ["kosher"], allergies: [], dislikes: [] };
    expect(isRecipeTitleUnsafeFor("Braised Pork Belly Ramen", HALAL)).not.toBeNull();
    expect(isRecipeTitleUnsafeFor("Red Wine Braised Short Ribs", HALAL)).not.toBeNull();
    expect(isRecipeTitleUnsafeFor("Bacon Wrapped Shrimp Skewers", KOSHER)).not.toBeNull();
  });
});

// Persona audit 2026-07-31, finding #3: mealProposer.ts's "fixed" role
// (garnishes/condiments) had zero safe-suggestion steering, unlike the
// "protein" role's safeProteinExamples -- these warnings are advisory
// prompt hints only, gated on the same synonym groups this file's real
// safety gate already trusts, never a substitute for it.
describe("condimentRiskWarnings", () => {
  it("warns about soy sauce/tamari/miso for a soy allergy", () => {
    const ctx: DietaryContext = { ...NONE, allergies: ["soy"] };
    const warnings = condimentRiskWarnings(ctx).join(" ").toLowerCase();
    expect(warnings).toContain("soy sauce");
    expect(warnings).toContain("tamari");
    expect(warnings).toContain("miso");
  });

  it("warns about honey for a vegan profile but not a merely vegetarian one", () => {
    const VEGAN: DietaryContext = { ...NONE, dietaryStyles: ["vegan"] };
    const VEGETARIAN: DietaryContext = { ...NONE, dietaryStyles: ["vegetarian"] };
    expect(condimentRiskWarnings(VEGAN).join(" ").toLowerCase()).toContain("honey");
    expect(condimentRiskWarnings(VEGETARIAN).join(" ").toLowerCase()).not.toContain("honey");
  });

  it("warns about fish/oyster sauce for a vegetarian profile even with no explicit fish allergy", () => {
    const ctx: DietaryContext = { ...NONE, dietaryStyles: ["vegetarian"] };
    const warnings = condimentRiskWarnings(ctx).join(" ").toLowerCase();
    expect(warnings).toContain("fish sauce");
    expect(warnings).toContain("oyster sauce");
  });

  it("warns about mayonnaise/aioli for an egg allergy", () => {
    const ctx: DietaryContext = { ...NONE, allergies: ["eggs"] };
    const warnings = condimentRiskWarnings(ctx).join(" ").toLowerCase();
    expect(warnings).toContain("mayonnaise");
    expect(warnings).toContain("aioli");
  });

  it("warns about butter/cream/parmesan for a dairy_free dietary style, not just a literal dairy allergy", () => {
    const ctx: DietaryContext = { ...NONE, dietaryStyles: ["dairy_free"] };
    const warnings = condimentRiskWarnings(ctx).join(" ").toLowerCase();
    expect(warnings).toContain("parmesan");
  });

  it("returns nothing for an unrestricted profile", () => {
    expect(condimentRiskWarnings(NONE)).toEqual([]);
  });

  it("does not warn about soy for a profile with no soy restriction", () => {
    const ctx: DietaryContext = { ...NONE, dietaryStyles: ["vegetarian"], allergies: ["nuts"] };
    expect(condimentRiskWarnings(ctx).join(" ").toLowerCase()).not.toContain("soy sauce");
  });
});
