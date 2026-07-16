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

// Audit round 3, finding 12: resolveDiet/resolveIntolerances/
// unsupportedDietaryStyles all filter through isDietaryStyle first, so a
// DIETARY_STYLE_OPTIONS entry in OnboardingWizard.tsx with no matching
// DIETARY_STYLE_MAP entry here doesn't go through the "unsupported, here's
// a disclaimer" path -- it's silently invisible to all three functions at
// once, worse than halal/kosher (which at least get an honest banner).
// Also guarded at compile time in OnboardingWizard.tsx via
// `satisfies readonly DietaryStyle[]`; this is the runtime backstop for
// anyone who bypasses that (e.g. an `as any` cast).
describe("onboarding preset sync guard", () => {
  // Mirrors OnboardingWizard.tsx's DIETARY_STYLE_OPTIONS -- kept as a
  // literal here (not imported) so this test doesn't drag a "use client"
  // component and its server-action imports into a lib-level unit test.
  const ONBOARDING_DIETARY_STYLE_OPTIONS = [
    "vegetarian",
    "vegan",
    "gluten_free",
    "dairy_free",
    "halal",
    "kosher",
  ];

  it("every onboarding style is accounted for by resolveDiet, resolveIntolerances, or unsupportedDietaryStyles", () => {
    const accountedFor = new Set([
      ...ONBOARDING_DIETARY_STYLE_OPTIONS.filter((s) => resolveDiet([s]) !== undefined),
      ...ONBOARDING_DIETARY_STYLE_OPTIONS.filter((s) => resolveIntolerances([s]).length > 0),
      ...unsupportedDietaryStyles(ONBOARDING_DIETARY_STYLE_OPTIONS),
    ]);
    expect([...accountedFor].sort()).toEqual([...ONBOARDING_DIETARY_STYLE_OPTIONS].sort());
  });
});
