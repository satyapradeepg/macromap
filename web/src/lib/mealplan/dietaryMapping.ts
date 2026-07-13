// Epic E2 (F3) — maps F2's onboarding dietary-style presets to Spoonacular's
// complexSearch params. Spoonacular's `diet` param is a single-value enum
// (only one wins if multiple map to it) and has no equivalent at all for
// halal/kosher — a gap not covered by docs/PRD-MacroMap.md, resolved here:
// gluten_free/dairy_free go through `intolerances` (which DOES support
// combining multiple values), halal/kosher are surfaced to the UI as
// unenforced rather than silently treated as filtered (see
// unsupportedDietaryStyles — consistent with allergy filtering's "never
// silently under-filter" safety precedent in docs/product-brief.md).

export type DietaryStyle =
  | "vegetarian"
  | "vegan"
  | "gluten_free"
  | "dairy_free"
  | "halal"
  | "kosher";

interface DietaryMapping {
  diet?: string;
  intolerance?: string;
}

const DIETARY_STYLE_MAP: Record<DietaryStyle, DietaryMapping> = {
  vegetarian: { diet: "vegetarian" },
  vegan: { diet: "vegan" },
  gluten_free: { intolerance: "Gluten" },
  dairy_free: { intolerance: "Dairy" },
  halal: {},
  kosher: {},
};

function isDietaryStyle(style: string): style is DietaryStyle {
  return style in DIETARY_STYLE_MAP;
}

// Spoonacular's `diet` param takes one value. Vegan implies vegetarian, so
// prefer vegan when a profile has both selected (shouldn't happen given F2's
// UI, but resolving deterministically here rather than relying on that).
export function resolveDiet(styles: string[]): string | undefined {
  const diets = styles
    .filter(isDietaryStyle)
    .map((style) => DIETARY_STYLE_MAP[style].diet)
    .filter((diet): diet is string => diet !== undefined);

  if (diets.includes("vegan")) return "vegan";
  return diets[0];
}

export function resolveIntolerances(styles: string[]): string[] {
  return styles
    .filter(isDietaryStyle)
    .map((style) => DIETARY_STYLE_MAP[style].intolerance)
    .filter((intolerance): intolerance is string => intolerance !== undefined);
}

// halal/kosher have no Spoonacular equivalent — the caller surfaces these
// as a disclaimer rather than pretending they were filtered for.
export function unsupportedDietaryStyles(styles: string[]): DietaryStyle[] {
  return styles.filter(isDietaryStyle).filter((style) => {
    const mapping = DIETARY_STYLE_MAP[style];
    return mapping.diet === undefined && mapping.intolerance === undefined;
  });
}
