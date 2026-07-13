import { describe, it, expect } from "vitest";
import { resolveDiet, resolveIntolerances, unsupportedDietaryStyles } from "./dietaryMapping";

describe("resolveDiet", () => {
  it("returns undefined when no styles map to diet", () => {
    expect(resolveDiet([])).toBeUndefined();
    expect(resolveDiet(["halal"])).toBeUndefined();
  });

  it("returns the mapped diet for a single style", () => {
    expect(resolveDiet(["vegetarian"])).toBe("vegetarian");
  });

  it("prefers vegan over vegetarian when both are set", () => {
    expect(resolveDiet(["vegetarian", "vegan"])).toBe("vegan");
  });
});

describe("resolveIntolerances", () => {
  it("maps gluten_free and dairy_free to Spoonacular intolerances", () => {
    expect(resolveIntolerances(["gluten_free", "dairy_free"])).toEqual(["Gluten", "Dairy"]);
  });

  it("ignores styles with no intolerance mapping", () => {
    expect(resolveIntolerances(["vegan", "halal"])).toEqual([]);
  });
});

describe("unsupportedDietaryStyles", () => {
  it("flags halal and kosher as unsupported", () => {
    expect(unsupportedDietaryStyles(["vegan", "halal", "kosher"])).toEqual(["halal", "kosher"]);
  });

  it("returns empty for fully-supported styles", () => {
    expect(unsupportedDietaryStyles(["vegan", "gluten_free"])).toEqual([]);
  });
});
