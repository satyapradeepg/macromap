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
      // Rank-based, not a percentage tie-band -- checked live July 15
      // 2026 against the real fixed-pool costs and a band would NOT have
      // fixed the bug it was meant to fix: the 2nd-cheapest option in
      // every real role is 43-570% pricier than the cheapest (e.g.
      // cottage cheese vs greek yogurt is +43%), so any band tight enough
      // to still mean "prefer cheap" only ever included one option,
      // reproducing the exact "same snack 14/14 times" bug this was
      // supposed to fix. Keeping the cheaper HALF (minimum 2, when at
      // least 2 exist) guarantees real rotation regardless of the dollar
      // gap, while still excluding the priciest option(s) from
      // consideration -- still a real budget bias, just one that can't
      // collapse to zero variety.
      const preferredN = Math.min(sortedKnown.length, Math.max(2, Math.ceil(sortedKnown.length / 2)));
      return { ordered: [...sortedKnown, ...unknown], preferredCount: preferredN };
    }
  }

  return { ordered: candidates, preferredCount: candidates.length };
}
