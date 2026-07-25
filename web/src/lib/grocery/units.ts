// Epic E3 (F4) grocery pricing fix — unit classification/conversion so a
// grocery line's price scales with its actual amount instead of a flat
// per-ingredient number (the bug: "1.5 tsps chia seeds" was priced the
// same as a whole bag, since nothing related price to quantity).
//
// Real unit vocabulary confirmed from a live generated plan's grocery
// list, not assumed: g, kg, ml, l, tsp/tsps, Tbsp/Tbsps are common and
// linearly convertible. Everything else (can, bottle, bag, loaf, clove,
// stalks, servings, medium, large, "large head", inches, "2-inch") is
// heterogeneous and not worth individually modeling — treated as "other"
// and priced per-unit-count instead (see groceryData.ts).

export type UnitCategory = "weight" | "volume" | "other";

const WEIGHT_TO_GRAMS: Record<string, number> = {
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilogram: 1000,
  kilograms: 1000,
  // Bare "oz" is classified as weight (matches Spoonacular's typical use
  // for solids) — "fl oz" is handled separately as volume.
  oz: 28.3495,
  ounce: 28.3495,
  ounces: 28.3495,
  lb: 453.592,
  lbs: 453.592,
  pound: 453.592,
  pounds: 453.592,
};

const VOLUME_TO_ML: Record<string, number> = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  l: 1000,
  liter: 1000,
  liters: 1000,
  litre: 1000,
  litres: 1000,
  tsp: 4.92892,
  tsps: 4.92892,
  teaspoon: 4.92892,
  teaspoons: 4.92892,
  tbsp: 14.7868,
  tbsps: 14.7868,
  tablespoon: 14.7868,
  tablespoons: 14.7868,
  cup: 236.588,
  cups: 236.588,
  "fl oz": 29.5735,
  "fluid ounce": 29.5735,
  "fluid ounces": 29.5735,
};

function normalize(unit: string): string {
  return unit.toLowerCase().trim();
}

export function classifyUnit(unit: string): UnitCategory {
  const normalized = normalize(unit);
  if (normalized in WEIGHT_TO_GRAMS) return "weight";
  if (normalized in VOLUME_TO_ML) return "volume";
  return "other";
}

export interface BaseAmount {
  baseAmount: number;
  baseUnit: "g" | "ml";
}

// Returns null for "other" units — there's no meaningful weight/volume
// conversion for a count/package/descriptor unit (can, clove, serving...).
export function toBaseAmount(amount: number, unit: string): BaseAmount | null {
  const normalized = normalize(unit);
  if (normalized in WEIGHT_TO_GRAMS) {
    return { baseAmount: amount * WEIGHT_TO_GRAMS[normalized], baseUnit: "g" };
  }
  if (normalized in VOLUME_TO_ML) {
    return { baseAmount: amount * VOLUME_TO_ML[normalized], baseUnit: "ml" };
  }
  return null;
}
