import { describe, it, expect } from "vitest";
import {
  commaSwapFallback,
  prefixStripFallback,
  glutenFreeQualifierStripFallback,
  slashToSpaceFallback,
  parseRecipeInformation,
  parsePrimaryAisle,
  repairOrRejectIngredientName,
} from "./spoonacular";

// Found live 2026-07-21 (thin-corpus AI-compose investigation): Spoonacular's
// ingredient search returned zero results for "jasmine rice, cooked" even
// though "cooked jasmine rice" is an entirely ordinary ingredient --
// following this codebase's own established pattern (mealProposer.ts) of
// testing pure logic directly rather than mocking fetch; lookupIngredientMacros
// itself has no dedicated unit test either, same reasoning.
describe("commaSwapFallback", () => {
  it("reorders a single comma-separated clause into natural-language order", () => {
    expect(commaSwapFallback("jasmine rice, cooked")).toBe("cooked jasmine rice");
    expect(commaSwapFallback("chicken breast, grilled")).toBe("grilled chicken breast");
  });

  it("trims whitespace around each clause", () => {
    expect(commaSwapFallback("jasmine rice ,  cooked ")).toBe("cooked jasmine rice");
  });

  it("returns null for a query with no comma -- nothing to reorder", () => {
    expect(commaSwapFallback("jasmine rice")).toBeNull();
  });

  it("returns null for a query with more than one comma -- only the single-clause case is handled", () => {
    expect(commaSwapFallback("rice, white, cooked")).toBeNull();
  });

  it("returns null if either clause is empty after trimming", () => {
    expect(commaSwapFallback("jasmine rice, ")).toBeNull();
    expect(commaSwapFallback(", cooked")).toBeNull();
  });
});

// Live-audited 2026-07-31 against ~750 distinct real ingredient names that
// had passed through this pipeline (turned up on real generated grocery
// lists) -- three distinct failure shapes, ~2.6% of all names.
describe("repairOrRejectIngredientName", () => {
  it("rejects a bare connector word with nothing else -- live-confirmed rendering as '101.2g to'", () => {
    expect(repairOrRejectIngredientName("to")).toBeNull();
    expect(repairOrRejectIngredientName("or")).toBeNull();
    expect(repairOrRejectIngredientName("and")).toBeNull();
  });

  it("is case- and whitespace-insensitive for the bare-word check", () => {
    expect(repairOrRejectIngredientName(" To ")).toBeNull();
    expect(repairOrRejectIngredientName("OR")).toBeNull();
  });

  it("accepts real ingredient names unchanged, including ones that merely contain a stopword as a substring or word", () => {
    expect(repairOrRejectIngredientName("chicken breast")).toBe("chicken breast");
    expect(repairOrRejectIngredientName("mandarin oranges")).toBe("mandarin oranges");
    // A real ingredient name that happens to START with a stopword-shaped
    // word but ISN'T one of the exact connector words this strips (e.g.
    // "a"/"an" are bare-word-only, not leading-connector candidates) is
    // never at risk.
    expect(repairOrRejectIngredientName("a la carte seasoning")).toBe("a la carte seasoning");
  });

  it("strips a leading connector word glued on by a mis-split quantity range, keeping the real ingredient", () => {
    expect(repairOrRejectIngredientName("of basil")).toBe("basil");
    expect(repairOrRejectIngredientName("to 5 chicken broth")).toBe("5 chicken broth");
    expect(repairOrRejectIngredientName("from 1 bunch basil")).toBe("1 bunch basil");
  });

  it("strips a leading instruction verb glued on by leaked instruction text, keeping the real ingredient", () => {
    expect(repairOrRejectIngredientName("fry 2 strips bacon")).toBe("2 strips bacon");
  });

  it("rejects when stripping the leading word leaves nothing or another bare stopword", () => {
    expect(repairOrRejectIngredientName("of a")).toBeNull();
  });

  it("rejects a run-on name with 2+ separate embedded quantities as unsalvageable", () => {
    expect(repairOrRejectIngredientName("swiss cheese 8 ounces cheddar 2 eggs")).toBeNull();
    expect(
      repairOrRejectIngredientName(
        "baby carrots 4 stalks celery 1 can mushrooms 1 piece pepper 1 cup flour and 3 tbsp 2 tablespoons bee",
      ),
    ).toBeNull();
  });

  it("keeps a real single-quantity descriptor with only one embedded digit group", () => {
    expect(repairOrRejectIngredientName('corn tortillas 4"')).toBe('corn tortillas 4"');
    expect(repairOrRejectIngredientName("ginger long 2 inch")).toBe("ginger long 2 inch");
  });

  // Live-confirmed 2026-08-01 (end-to-end test of the deployed app): a
  // recipe title + serving-size label fragment split on a colon reached a
  // real generated grocery list -- neither side of the colon is a
  // trustworthy real ingredient, so this is dropped entirely rather than
  // repaired, same as the run-on-concatenation shape above.
  it("rejects a name containing a colon -- a recipe title/serving-size label leak, not a real ingredient", () => {
    expect(repairOrRejectIngredientName("sundried tomato & artichoke tuna casserole: serves")).toBeNull();
    expect(repairOrRejectIngredientName("Serves: 4")).toBeNull();
  });

  it("still rejects a colon-containing name even after a leading connector is stripped", () => {
    expect(repairOrRejectIngredientName("of casserole: serves")).toBeNull();
  });
});

// Audit item #1 (2026-07-21 spec): a leading prep-word with no comma at
// all (e.g. "steamed broccoli florets") is a distinct case from
// commaSwapFallback's "name, modifier" phrasing -- live-confirmed
// zero-result searches for exactly this shape in Finding 2.
describe("prefixStripFallback", () => {
  it("strips a leading prep-word prefix", () => {
    expect(prefixStripFallback("steamed broccoli florets")).toBe("broccoli florets");
    expect(prefixStripFallback("roasted sweet potato")).toBe("sweet potato");
    expect(prefixStripFallback("grilled chicken breast")).toBe("chicken breast");
  });

  it("matches case-insensitively", () => {
    expect(prefixStripFallback("STEAMED broccoli florets")).toBe("broccoli florets");
  });

  it("handles both accented and unaccented 'sauteed'", () => {
    expect(prefixStripFallback("sauteed onions")).toBe("onions");
    expect(prefixStripFallback("sautéed onions")).toBe("onions");
  });

  it("returns null when no known prep-word prefix is present", () => {
    expect(prefixStripFallback("broccoli florets")).toBeNull();
  });

  it("returns null when stripping the prefix would leave nothing", () => {
    expect(prefixStripFallback("steamed")).toBeNull();
    expect(prefixStripFallback("steamed ")).toBeNull();
  });

  it("only strips a leading occurrence, not one appearing mid-name", () => {
    expect(prefixStripFallback("baby carrots, steamed")).toBeNull();
  });

  // Added 2026-07-27 (marathon-session queue item #2): live AI-compose
  // diagnostic against vegetarian_cut found "sliced" hitting the same
  // zero-result pattern as the other prep-word prefixes.
  it("strips a leading 'sliced' prefix", () => {
    expect(prefixStripFallback("sliced avocado")).toBe("avocado");
    expect(prefixStripFallback("SLICED almonds")).toBe("almonds");
  });

  // Trailing counterpart found in the same diagnostic: a meat-analogue
  // ingredient named with a trailing shape descriptor Spoonacular's search
  // doesn't recognize either.
  it("strips a trailing 'strips' descriptor", () => {
    expect(prefixStripFallback("tempeh bacon strips")).toBe("tempeh bacon");
    expect(prefixStripFallback("chicken strips")).toBe("chicken");
  });

  it("strips a trailing 'crumbles' descriptor", () => {
    expect(prefixStripFallback("seitan crumbles")).toBe("seitan");
    expect(prefixStripFallback("tofu crumbles")).toBe("tofu");
  });

  it("matches trailing descriptors case-insensitively", () => {
    expect(prefixStripFallback("seitan CRUMBLES")).toBe("seitan");
  });

  it("returns null when stripping a trailing descriptor would leave nothing", () => {
    expect(prefixStripFallback("strips")).toBeNull();
    expect(prefixStripFallback("crumbles")).toBeNull();
  });

  it("only strips a trailing occurrence, not one appearing mid-name", () => {
    expect(prefixStripFallback("crumbles of seitan")).toBeNull();
  });

  it("prefers the leading-prefix match when both a leading and trailing descriptor are present", () => {
    // "sliced" is stripped first; the trailing "strips" on the remainder is
    // left untouched by this single call, matching every other fallback in
    // this file being a one-shot retry, not a multi-pass rewrite.
    expect(prefixStripFallback("sliced bacon strips")).toBe("bacon strips");
  });

  // Added 2026-08-01, live-confirmed on user2's (vegan, soy allergy)
  // generated plan: neither the original comma-form query nor
  // commaSwapFallback's reorder matched Spoonacular's search for either of
  // these two real dropped ingredients.
  it("strips a leading 'diced' prefix", () => {
    expect(prefixStripFallback("diced russet potatoes")).toBe("russet potatoes");
  });

  it("strips a trailing 'diced' descriptor and the leftover comma", () => {
    expect(prefixStripFallback("russet potatoes, diced")).toBe("russet potatoes");
  });

  it("strips a trailing 'crumbled' descriptor and the leftover comma", () => {
    expect(prefixStripFallback("seitan, crumbled")).toBe("seitan");
  });

  // Live-confirmed 2026-08-09 (F11 chat-driven meal editing, production):
  // "strong mushroom broth" -- a real ingredient name already present in a
  // live Spoonacular recipe -- returned zero search results.
  it("strips a leading 'strong' prefix", () => {
    expect(prefixStripFallback("strong mushroom broth")).toBe("mushroom broth");
    expect(prefixStripFallback("STRONG coffee")).toBe("coffee");
  });
});

// Live-confirmed 2026-08-09, same F11 session as the "strong" fix above:
// "firm/extra tofu" -- a real ingredient name from a live Spoonacular
// recipe's own stored data -- returned zero search results, while the
// exact same words space-separated ("firm extra tofu") matched
// immediately (confirmed directly against the real search API).
describe("slashToSpaceFallback", () => {
  it("replaces a slash with a space", () => {
    expect(slashToSpaceFallback("firm/extra tofu")).toBe("firm extra tofu");
  });

  it("collapses any resulting double space", () => {
    expect(slashToSpaceFallback("firm / extra tofu")).toBe("firm extra tofu");
  });

  it("returns null when there's no slash at all", () => {
    expect(slashToSpaceFallback("extra firm tofu")).toBeNull();
  });

  it("returns null if replacing the slash doesn't actually change anything", () => {
    expect(slashToSpaceFallback("tofu")).toBeNull();
  });
});

// Sibling gap to audit item #1, live-confirmed 2026-07-22 (stacked-safety
// re-verification): "gluten-free rolled oats" and "rolled oats
// (gluten-free)" both returned zero results from Spoonacular's search.
describe("glutenFreeQualifierStripFallback", () => {
  it("strips a leading 'gluten-free' qualifier", () => {
    expect(glutenFreeQualifierStripFallback("gluten-free rolled oats")).toBe("rolled oats");
    expect(glutenFreeQualifierStripFallback("gluten free rolled oats")).toBe("rolled oats");
  });

  it("strips a trailing '(gluten-free)' parenthetical qualifier", () => {
    expect(glutenFreeQualifierStripFallback("rolled oats (gluten-free)")).toBe("rolled oats");
    expect(glutenFreeQualifierStripFallback("rolled oats (gluten free)")).toBe("rolled oats");
  });

  it("matches case-insensitively", () => {
    expect(glutenFreeQualifierStripFallback("GLUTEN-FREE rolled oats")).toBe("rolled oats");
    expect(glutenFreeQualifierStripFallback("rolled oats (GLUTEN-FREE)")).toBe("rolled oats");
  });

  it("returns null when no gluten-free qualifier is present", () => {
    expect(glutenFreeQualifierStripFallback("rolled oats")).toBeNull();
  });

  it("returns null when stripping the leading qualifier would leave nothing", () => {
    expect(glutenFreeQualifierStripFallback("gluten-free")).toBeNull();
    expect(glutenFreeQualifierStripFallback("gluten-free ")).toBeNull();
  });

  it("does not touch an unrelated allergen-free qualifier -- deliberately scoped to gluten-free only", () => {
    expect(glutenFreeQualifierStripFallback("dairy-free yogurt")).toBeNull();
    expect(glutenFreeQualifierStripFallback("yogurt (dairy-free)")).toBeNull();
  });
});

describe("parseRecipeInformation", () => {
  it("flattens analyzedInstructions' steps across all sections, in order", () => {
    const result = parseRecipeInformation({
      analyzedInstructions: [
        { steps: [{ step: "Preheat oven to 400F." }, { step: "Chop the onion." }] },
      ],
      sourceUrl: "https://example.com/recipe",
    });
    expect(result.steps).toEqual(["Preheat oven to 400F.", "Chop the onion."]);
    expect(result.sourceUrl).toBe("https://example.com/recipe");
  });

  it("falls back to spoonacularSourceUrl when sourceUrl is absent", () => {
    const result = parseRecipeInformation({ spoonacularSourceUrl: "https://spoonacular.com/recipe/1" });
    expect(result.sourceUrl).toBe("https://spoonacular.com/recipe/1");
  });

  it("returns null sourceUrl when neither is present", () => {
    expect(parseRecipeInformation({}).sourceUrl).toBeNull();
  });

  it("filters out empty/non-string steps rather than including blanks", () => {
    const result = parseRecipeInformation({
      analyzedInstructions: [{ steps: [{ step: "Real step." }, { step: "" }, { step: undefined }] }],
    });
    expect(result.steps).toEqual(["Real step."]);
  });

  it("returns an empty steps array when analyzedInstructions is missing entirely", () => {
    expect(parseRecipeInformation({}).steps).toEqual([]);
  });

  it("never throws on malformed/unexpected input shapes", () => {
    expect(parseRecipeInformation(null).steps).toEqual([]);
    expect(parseRecipeInformation("garbage").steps).toEqual([]);
    expect(parseRecipeInformation({ analyzedInstructions: "not an array" }).steps).toEqual([]);
  });
});

describe("parsePrimaryAisle", () => {
  it("returns a plain single-aisle string unchanged", () => {
    expect(parsePrimaryAisle("Baking")).toBe("Baking");
  });

  it("takes only the first aisle from a semicolon-joined list", () => {
    // Live-confirmed 2026-07-25: corn tortillas returned exactly this.
    expect(parsePrimaryAisle("BAKERY/BREAD;PASTA AND RICE;ETHNIC FOODS")).toBe("BAKERY/BREAD");
  });

  it("leaves a '/' within one segment alone -- a compound label, not a list", () => {
    expect(parsePrimaryAisle("Milk, Eggs, Other Dairy")).toBe("Milk, Eggs, Other Dairy");
  });

  it("trims whitespace around the first segment", () => {
    expect(parsePrimaryAisle("  Produce  ; Other")).toBe("Produce");
  });

  it("returns null for undefined or empty input", () => {
    expect(parsePrimaryAisle(undefined)).toBeNull();
    expect(parsePrimaryAisle("")).toBeNull();
    expect(parsePrimaryAisle(";;;")).toBeNull();
  });
});
