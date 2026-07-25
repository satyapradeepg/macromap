import { describe, it, expect } from "vitest";
import { aisleCacheKey, parseAisleEstimate } from "./ingredientAisle";

describe("aisleCacheKey", () => {
  it("keys by id for a valid, resolved ingredient id", () => {
    expect(aisleCacheKey(11529, "tomato")).toBe("id:11529");
  });

  it("keys by normalized name for a placeholder/unresolved id", () => {
    expect(aisleCacheKey(-1, "Mayonaisse")).toBe("name:mayonaisse");
    expect(aisleCacheKey(0, "  Garnish  ")).toBe("name:garnish");
  });

  it("treats a non-integer id as unresolved too", () => {
    expect(aisleCacheKey(1.5, "something")).toBe("name:something");
  });
});

describe("parseAisleEstimate", () => {
  it("accepts a well-formed aisle string", () => {
    expect(parseAisleEstimate({ aisle: "Produce" })).toBe("Produce");
  });

  it("trims whitespace", () => {
    expect(parseAisleEstimate({ aisle: "  Dairy  " })).toBe("Dairy");
  });

  it("rejects a missing aisle field", () => {
    expect(parseAisleEstimate({})).toBeNull();
  });

  it("rejects a non-string aisle", () => {
    expect(parseAisleEstimate({ aisle: 42 })).toBeNull();
  });

  it("rejects an empty/whitespace-only string", () => {
    expect(parseAisleEstimate({ aisle: "" })).toBeNull();
    expect(parseAisleEstimate({ aisle: "   " })).toBeNull();
  });

  it("rejects null or non-object input", () => {
    expect(parseAisleEstimate(null)).toBeNull();
    expect(parseAisleEstimate("a string")).toBeNull();
  });
});
