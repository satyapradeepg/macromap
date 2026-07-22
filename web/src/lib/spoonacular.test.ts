import { describe, it, expect } from "vitest";
import { commaSwapFallback } from "./spoonacular";

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
