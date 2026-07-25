// Epic F3/F6 follow-up (quantity-aware pantry depletion) -- extends the
// boolean-only pantryOverlapDeduction (ranking.ts) with a live, mutable
// "how much is left" tracker that depletes as slots get claimed across a
// generation pass, instead of giving every slot the same static signal
// regardless of what earlier slots already used. Modeled directly on
// src/lib/grocery/aggregate.ts's PantryPool/buildPantryPools/
// applyPantryToLine -- same problem (a pantry item's on-hand quantity as
// a shared pool consumed across many matching lines), same solution,
// deliberately not reinvented (this codebase's convention: a small
// per-file copy over a cross-module dependency, same as
// wordBoundaryIncludes below).
//
// Strict superset of today's behavior by construction: a pantry item
// with no structured amount/unit (the common case -- F6 quantity entry
// is optional) becomes an "unlimited" pool that contributes the same
// boolean bonus as today and never depletes; a pantry item whose identity
// match or unit conversion couldn't be resolved (LLM/API failure, or an
// ingredient name never seen in this generation's candidate pools) falls
// back the same way. Only a pantry item with BOTH a real quantity AND a
// successfully resolved match/conversion ever actually depletes.
//
// Deliberately pure/sync/no-network in every function EXCEPT
// resolvePantryMatchInfo -- matches ranking.ts's own "No LLM: this is a
// plain weighted-deviation score" discipline. resolvePantryMatchInfo must
// run in an async pre-pass BEFORE ranking starts (see orchestrate.ts);
// doing identity/conversion resolution live per-candidate during ranking
// would be far too slow at up to 60 candidates x 21 slots.

import { classifyUnit, toBaseAmount, type UnitCategory } from "../grocery/units";
import { resolveIdentityMatches } from "../grocery/identityMatch";
import { resolveConversionRate } from "../grocery/unitConversion";
import type { CandidateIngredient, PantryItem } from "./ranking";

function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}s?\\b`).test(haystack);
}

function namesOverlap(a: string, b: string): boolean {
  return wordBoundaryIncludes(a, b) || wordBoundaryIncludes(b, a);
}

function normalizeOtherUnit(unit: string): string {
  return unit.toLowerCase().trim().replace(/s$/, "");
}

function matchesPantryItem(ing: CandidateIngredient, item: PantryItem, matchedNames: Set<string> | null): boolean {
  if (item.spoonacularIngredientId !== null) {
    return ing.id === item.spoonacularIngredientId;
  }
  if (matchedNames) {
    return matchedNames.has(ing.name.toLowerCase().trim());
  }
  return namesOverlap(ing.name.toLowerCase(), item.name.toLowerCase());
}

// One pool per pantry_items row (index-keyed, never by resolved
// ingredient id or matched name) -- the same real ingredient can carry
// several different Spoonacular ids across a plan's candidates (this
// app's own confirmed "garlic splits into 4-5 ids per plan" fact), so
// keying by pantry item identity and matching many-to-one is what avoids
// splitting one physical item's stock across several unrelated pools.
// `remainingBase` is deliberately UNCLAMPED -- only ever clamped to >=0
// at the read boundary (pantryCoverage). This is what makes
// commitPantryConsumption/releasePantryConsumption exact inverses
// without needing extra state on the caller's claimed-slot record: both
// recompute the same "required" amount from the same ingredient list,
// and adding/subtracting that same number is symmetric by construction
// only if nothing was clamped away in between.
export interface PantryRemainingPool {
  item: PantryItem;
  category: UnitCategory | null; // null = no usable structured quantity at all -> unlimited/boolean-only
  otherDescriptor: string | null; // set only when category === "other"
  remainingBase: number;
  matchedIngredientNames: Set<string> | null; // from the async pre-pass; null -> falls back to namesOverlap
  unitConversionRates: Map<string, number> | null; // from the async pre-pass; keyed by a candidate ingredient's lowercased metricUnit
}

export interface PantryRemainingTracker {
  pools: PantryRemainingPool[];
}

export interface PantryItemMatchInfo {
  matchedIngredientNames: Set<string> | null;
  unitConversionRates: Map<string, number> | null;
}

// Pure, sync, no network -- matchInfo must already be resolved (see
// resolvePantryMatchInfo below). Mirrors aggregate.ts's buildPantryPools
// almost exactly, keyed by pantry item array index into `matchInfo`.
export function buildPantryRemainingTracker(
  pantryItems: PantryItem[],
  matchInfo: Map<number, PantryItemMatchInfo>,
): PantryRemainingTracker {
  const pools = pantryItems.map((item, index): PantryRemainingPool => {
    const info = matchInfo.get(index) ?? null;
    const matchedIngredientNames = info?.matchedIngredientNames ?? null;
    const unitConversionRates = info?.unitConversionRates ?? null;

    if (item.amount === null || item.unit === null) {
      return { item, category: null, otherDescriptor: null, remainingBase: 0, matchedIngredientNames, unitConversionRates };
    }
    const category = classifyUnit(item.unit);
    if (category === "other") {
      return {
        item,
        category,
        otherDescriptor: normalizeOtherUnit(item.unit),
        remainingBase: item.amount,
        matchedIngredientNames,
        unitConversionRates,
      };
    }
    const base = toBaseAmount(item.amount, item.unit);
    return {
      item,
      category,
      otherDescriptor: null,
      remainingBase: base ? base.baseAmount : 0,
      matchedIngredientNames,
      unitConversionRates,
    };
  });
  return { pools };
}

function matchesAnyIngredient(pool: PantryRemainingPool, ingredients: CandidateIngredient[]): boolean {
  return ingredients.some((ing) => matchesPantryItem(ing, pool.item, pool.matchedIngredientNames));
}

// Sums every candidate ingredient line that matches `pool`, converted
// into the pool's own base unit -- mirrors aggregate.ts's
// applyPantryToLine rate logic (same-category exact/descriptor match, or
// a cross-category rate from unitConversionRates), but summed across ALL
// matching lines within ONE candidate into a single total rather than
// applied per-line independently. This is what prevents one real pantry
// item from being "spent" more than once against a single recipe that
// happens to use it twice (e.g. garlic in two different prep forms) --
// the exact bug class already found and fixed on the grocery-list side
// this session (aggregate.ts's PantryPool comment), not reproduced here.
// A line that matches by name/id but can't be rate-converted simply
// doesn't contribute to `requiredInPoolBase` -- `matched` still reports
// true so scoring/coverage still sees it, just with nothing quantified.
function requiredFromPoolBase(
  pool: PantryRemainingPool,
  ingredients: CandidateIngredient[],
): { matched: boolean; requiredInPoolBase: number } {
  let matched = false;
  let requiredInPoolBase = 0;

  for (const ing of ingredients) {
    if (!matchesPantryItem(ing, pool.item, pool.matchedIngredientNames)) continue;
    matched = true;
    if (pool.category === null) continue; // unlimited pool -- matched for scoring, nothing to quantify

    const ingCategory = classifyUnit(ing.metricUnit);
    if (ingCategory === pool.category) {
      if (pool.category === "other") {
        if (pool.otherDescriptor === normalizeOtherUnit(ing.metricUnit)) {
          requiredInPoolBase += ing.metricAmount;
        }
        continue;
      }
      const base = toBaseAmount(ing.metricAmount, ing.metricUnit);
      if (base) requiredInPoolBase += base.baseAmount;
      continue;
    }

    const rate = pool.unitConversionRates?.get(ing.metricUnit.toLowerCase().trim());
    if (rate) requiredInPoolBase += ing.metricAmount / rate;
  }

  return { matched, requiredInPoolBase };
}

// Read-only -- used by ranking.ts's pantryOverlapDeduction. NEVER mutates
// `tracker`. A pool counts as covered if this candidate's ingredients
// match it AND (the pool has no real quantity tracked at all -- today's
// exact boolean behavior -- OR it still has stock left). `remainingBase`
// is clamped to >=0 ONLY here, at this read boundary; see
// PantryRemainingPool's own comment for why the mutation side never
// clamps.
export function pantryCoverage(tracker: PantryRemainingTracker, ingredients: CandidateIngredient[]): boolean[] {
  return tracker.pools.map((pool) => {
    if (!matchesAnyIngredient(pool, ingredients)) return false;
    return pool.category === null || pool.remainingBase > 0;
  });
}

// Mutates `tracker`. Call ONLY at real claim/replace sites in
// orchestrate.ts, never from inside rankCandidates/runCascadeForSlot --
// re-scoring the same candidate multiple times before it's ever claimed
// (exhaustion retries, reconciliation/protein-floor requeries) must never
// deplete a pool; only an actual commit may.
export function commitPantryConsumption(tracker: PantryRemainingTracker, ingredients: CandidateIngredient[]): void {
  for (const pool of tracker.pools) {
    if (pool.category === null) continue;
    const { matched, requiredInPoolBase } = requiredFromPoolBase(pool, ingredients);
    if (matched) pool.remainingBase -= requiredInPoolBase;
  }
}

// Exact inverse of commitPantryConsumption for the SAME ingredients --
// recomputes the same requiredInPoolBase and adds it back. Symmetric by
// construction only because remainingBase is never clamped internally
// (see PantryRemainingPool's comment) -- do not "fix" a negative
// remainingBase by clamping it, or release will over-credit the pool.
export function releasePantryConsumption(tracker: PantryRemainingTracker, ingredients: CandidateIngredient[]): void {
  for (const pool of tracker.pools) {
    if (pool.category === null) continue;
    const { matched, requiredInPoolBase } = requiredFromPoolBase(pool, ingredients);
    if (matched) pool.remainingBase += requiredInPoolBase;
  }
}

// Builds an unresolved tracker (no LLM/unit-conversion pre-pass -- see
// header comment) and immediately commits every already-known ingredient
// list into it. Used by the standalone swap-meal action (actions.ts's
// swapMeal), which has no live rankOpts.pantryTracker to reuse the way
// critic-repair's in-generation swap does -- this lets a swap still
// account for what the REST of the current plan's slots have already
// consumed, using only same-category/id/namesOverlap matching (tier 2 of
// the three-tier degrade contract above), with no network calls and thus
// no added latency versus today's swap.
export function buildTrackerFromKnownConsumption(
  pantryItems: PantryItem[],
  consumedIngredientLists: CandidateIngredient[][],
): PantryRemainingTracker {
  const tracker = buildPantryRemainingTracker(pantryItems, new Map());
  for (const ingredients of consumedIngredientLists) {
    commitPantryConsumption(tracker, ingredients);
  }
  return tracker;
}

// The ONLY place this feature calls the network (LLM identity matching +
// Spoonacular density conversion) -- must run BEFORE ranking starts.
// Resolved once per pantry item, in parallel (each item's failure is
// isolated -- one item's resolveIdentityMatches/resolveConversionRate
// throwing must not degrade any other item), against the union of
// distinct (name, unit) pairs harvested from the initial candidate pools.
// An ingredient name/unit first appearing later (a different-cache-key
// retry/requery) was never in this universe and simply falls back to
// namesOverlap/unlimited in buildPantryRemainingTracker -- same
// "degrade, never crash" contract as every other resolution failure in
// this codebase (identityMatch.ts, unitConversion.ts, aggregate.ts).
//
// Mirrors groceryData.ts's existing async pre-pass almost exactly (same
// two calls, same per-item isolation via independent try/catch) -- see
// that file for the sibling implementation this was modeled on.
export async function resolvePantryMatchInfo(
  pantryItems: PantryItem[],
  candidateIngredients: Array<{ name: string; unit: string }>,
): Promise<Map<number, PantryItemMatchInfo>> {
  const distinctNames = [...new Set(candidateIngredients.map((c) => c.name))];
  const unitsByName = new Map<string, Set<string>>();
  for (const c of candidateIngredients) {
    const key = c.name.toLowerCase().trim();
    const existing = unitsByName.get(key);
    if (existing) existing.add(c.unit);
    else unitsByName.set(key, new Set([c.unit]));
  }

  const result = new Map<number, PantryItemMatchInfo>();

  await Promise.all(
    pantryItems.map(async (item, index) => {
      // id-resolved items short-circuit matching entirely in
      // matchesPantryItem -- no name/unit resolution needed, same
      // precedent as aggregate.ts's identical id-first check.
      if (item.spoonacularIngredientId !== null) return;

      try {
        const matchedIngredientNames = await resolveIdentityMatches(item.name, distinctNames);
        result.set(index, { matchedIngredientNames, unitConversionRates: null });

        if (item.amount === null || item.unit === null || matchedIngredientNames.size === 0) return;

        const itemCategory = classifyUnit(item.unit);
        const sourceUnit = itemCategory === "weight" ? "g" : itemCategory === "volume" ? "ml" : item.unit;
        const itemDescriptor = itemCategory === "other" ? normalizeOtherUnit(item.unit) : null;

        const targetUnits = new Set<string>();
        for (const name of matchedIngredientNames) {
          for (const unit of unitsByName.get(name) ?? []) {
            const unitCategory = classifyUnit(unit);
            const mismatched =
              unitCategory !== itemCategory || (itemCategory === "other" && normalizeOtherUnit(unit) !== itemDescriptor);
            if (mismatched) targetUnits.add(unit.toLowerCase().trim());
          }
        }
        if (targetUnits.size === 0) return;

        const rates = new Map<string, number>();
        await Promise.all(
          [...targetUnits].map(async (targetUnit) => {
            const rate = await resolveConversionRate(item.name, sourceUnit, targetUnit);
            if (rate) rates.set(targetUnit, rate);
          }),
        );
        result.set(index, { matchedIngredientNames, unitConversionRates: rates.size > 0 ? rates : null });
      } catch {
        // Leave this pantry item unresolved for this pass -- falls back
        // to namesOverlap matching / unlimited-pool depletion in
        // buildPantryRemainingTracker, never a crash or a silent
        // half-resolved state.
      }
    }),
  );

  return result;
}
