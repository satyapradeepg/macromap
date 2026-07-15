// Shared pantry/price preference logic for the fixed-pool ingredient
// system (snackComposition.ts, addon.ts). Retrofitted July 15 2026 after
// confirming both files had neither, unlike the recipe-search path's real
// pantryOverlapDeduction (ranking.ts) and budgetCompliant mechanisms.
//
// Deliberately a SOFT reordering, never a hard filter — mirrors this
// project's standing rule (docs/PRD-MacroMap.md 7.3 F3, and ranking.ts's
// own comment) that pantry/budget preference must never override safety
// or cause a slot to go unfilled that would otherwise have filled. The
// safety gate (ingredientSafety.ts) already ran and produced `candidates`
// before this is called; this only decides which order to try/pick the
// remaining safe candidates in.
//
// Priority: a pantry match wins outright (matches ranking.ts's framing of
// pantry as a preference to satisfy when possible); failing that, and
// only when budget-aware, prefer the cheapest known-cost option(s). Never
// reorders based on price when cost data is missing for enough
// candidates to make a meaningful comparison.
export interface PantryPriceContext {
  pantryItemNames: string[];
  budgetAware: boolean;
}

export interface RankedByPreference<T> {
  // Full reorder, preferred-first, stable within each tier -- what
  // addon.ts wants (tries each in order until one resolves).
  ordered: T[];
  // How many items at the FRONT of `ordered` are equally top-preferred
  // (all pantry matches, or all tied-cheapest) -- what composeSnack wants,
  // so its variety-seed rotation stays WITHIN the preferred tier instead
  // of cycling across the whole reordered list (which would silently
  // undo the preference half the time).
  preferredCount: number;
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function matchesPantry(ingredientName: string, pantryItemNames: string[]): boolean {
  const name = normalize(ingredientName);
  return pantryItemNames.some((p) => {
    const pn = normalize(p);
    return pn.length > 0 && (name.includes(pn) || pn.includes(name));
  });
}

export function rankByPantryAndPrice<T extends { name: string; costCentsPer100g: number | null }>(
  candidates: T[],
  ctx: PantryPriceContext,
): RankedByPreference<T> {
  const pantryMatches = candidates.filter((c) => matchesPantry(c.name, ctx.pantryItemNames));
  if (pantryMatches.length > 0) {
    const rest = candidates.filter((c) => !pantryMatches.includes(c));
    return { ordered: [...pantryMatches, ...rest], preferredCount: pantryMatches.length };
  }

  if (ctx.budgetAware) {
    const known = candidates.filter((c) => c.costCentsPer100g !== null);
    if (known.length >= 2) {
      const unknown = candidates.filter((c) => c.costCentsPer100g === null);
      const sortedKnown = [...known].sort((a, b) => a.costCentsPer100g! - b.costCentsPer100g!);
      const cheapest = sortedKnown[0].costCentsPer100g!;
      const tiedCheapest = sortedKnown.filter((c) => c.costCentsPer100g === cheapest).length;
      return { ordered: [...sortedKnown, ...unknown], preferredCount: tiedCheapest };
    }
  }

  return { ordered: candidates, preferredCount: candidates.length };
}
