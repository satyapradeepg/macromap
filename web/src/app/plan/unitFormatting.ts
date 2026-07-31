// Shared singular/plural unit logic (2026-07-30 UI pass) -- PlanView.tsx's
// formatIngredientAmount and GroceryList.tsx's formatAmount each round an
// ingredient amount to 1 decimal but neither had ANY plural awareness, so
// whatever unit string Spoonacular happened to return (e.g. "cups") got
// used verbatim regardless of the rounded amount, producing "1 cups
// water". Word-length units (cup, pound, teaspoon, clove...) are all
// regular plurals in Spoonacular's real ingredient data -- no irregular
// cases to special-case. Short/metric units (g, ml, oz, L) never
// pluralize and are left untouched, matching GroceryList.tsx's existing
// `unit.length <= 2` heuristic for "this is a metric abbreviation."
export function pluralizeUnit(unit: string, roundedAmount: number): string {
  if (!unit || unit.length <= 2) return unit;
  const singular = unit.endsWith("s") && !unit.endsWith("ss") ? unit.slice(0, -1) : unit;
  return roundedAmount === 1 ? singular : `${singular}s`;
}
