import { describe, it, expect } from "vitest";
import {
  commaSwapFallback,
  prefixStripFallback,
  glutenFreeQualifierStripFallback,
  parseRecipeInformation,
  parsePrimaryAisle,
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
