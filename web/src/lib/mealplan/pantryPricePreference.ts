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
//
// Pantry-match branch fixed July 15 2026 (audit round 2) to carry the same
// minimum-2-preferred floor the budget branch already had: a real pantry
// almost always matches exactly ONE pool item per macro role (a 15-item
// pantry test confirmed this live), which used to collapse preferredCount
// to 1 -- composeSnack's variety-seed rotation then has nothing to rotate
// within, reproducing the exact "same snack 14/14 times" bug this file's
// budget branch was already fixed for, just via a different trigger.
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

// Word-boundary match, not a bare bidirectional substring check -- same
// bug class already fixed the same day in openEndedIngredientSafety.ts
// and ranking.ts's pantryOverlapDeduction (audit round 3, July 15 2026).
// A bare `name.includes(pn) || pn.includes(name)` let pantry "pea" match
// pool item "pea protein powder" indiscriminately and pantry "nut" match
// both "walnuts" and "peanut butter", collapsing distinct allergen-
// relevant items into one preference bucket. Allows an optional trailing
// "s" so pantry "yogurt" still matches pool item "greek yogurt".
function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}s?\\b`).test(haystack);
}

function matchesPantry(ingredientName: string, pantryItemNames: string[]): boolean {
  const name = normalize(ingredientName);
  return pantryItemNames.some((p) => {
    const pn = normalize(p);
    return pn.length > 0 && (wordBoundaryIncludes(name, pn) || wordBoundaryIncludes(pn, name));
  });
}

// Shared by both branches below so the two never drift apart -- known-cost
// items ascending, unknown-cost items last (never reordered based on
// missing data).
function sortCheapestFirst<T extends { costCentsPer100g: number | null }>(items: T[]): T[] {
  const known = items.filter((c) => c.costCentsPer100g !== null);
  const unknown = items.filter((c) => c.costCentsPer100g === null);
  const sortedKnown = [...known].sort((a, b) => a.costCentsPer100g! - b.costCentsPer100g!);
  return [...sortedKnown, ...unknown];
}

export function rankByPantryAndPrice<T extends { name: string; costCentsPer100g: number | null }>(
  candidates: T[],
  ctx: PantryPriceContext,
): RankedByPreference<T> {
  const pantryMatches = candidates.filter((c) => matchesPantry(c.name, ctx.pantryItemNames));
  if (pantryMatches.length > 0) {
    const nonMatches = candidates.filter((c) => !pantryMatches.includes(c));
    // Refinement: when also budget-aware, the backup/topped-up slots below
    // prefer the cheapest of the non-matching candidates rather than
    // whatever order they happened to be in -- "pantry match wins, cheapest
    // breaks remaining ties," not required to fix the variety collapse
    // itself but a reasonable secondary preference given the cost data is
    // already there.
    const rest = ctx.budgetAware ? sortCheapestFirst(nonMatches) : nonMatches;
    // Same minimum-2-preferred floor as the budget branch below, and for
    // the same reason: a preferred tier of exactly 1 leaves composeSnack's
    // variety-seed rotation with nothing to rotate within.
    const preferredN = Math.min(candidates.length, Math.max(pantryMatches.length, 2));
    return { ordered: [...pantryMatches, ...rest], preferredCount: preferredN };
  }

  if (ctx.budgetAware) {
    const known = candidates.filter((c) => c.costCentsPer100g !== null);
    if (known.length >= 2) {
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
      const preferredN = Math.min(known.length, Math.max(2, Math.ceil(known.length / 2)));
      return { ordered: sortCheapestFirst(candidates), preferredCount: preferredN };
    }
  }

  return { ordered: candidates, preferredCount: candidates.length };
}
