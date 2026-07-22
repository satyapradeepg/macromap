import { describe, it, expect } from "vitest";
import { commaSwapFallback, prefixStripFallback } from "./spoonacular";

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
