// Epic E3 (F4) — deterministic grocery-list aggregation. No LLM, no network:
// pure grouping/summing over data already persisted during E2 generation
// (docs/PRD-MacroMap.md 7.3 F4, OQ4).
//
// A plan now has 35 slots/week (7 days x breakfast/lunch/dinner/snack1/
// snack2 — migration 0010_snack_slots.sql), and any slot can additionally
// carry one add-on row in the separate meal_plan_slot_addons table
// (migration 0008_meal_plan_ai_composition.sql) — an add-on is NOT nested
// inside a slot's `ingredients` jsonb, so both inputs must be passed in
// here explicitly or the grocery list silently under-counts every plan
// that used the F3 gap-closer mechanism.

import { classifyUnit, toBaseAmount, type UnitCategory } from "./units";

export interface SlotIngredientEntry {
  id: number;
  name: string;
  metricAmount: number;
  metricUnit: string;
}

// meal_plan_slot_addons.unit is hardcoded "g" at insert time
// (src/app/plan/actions.ts) — addons never need unit reconciliation, only
// merging into the aggregate by id.
export interface AddonEntry {
  ingredientId: number;
  ingredientName: string;
  amountG: number;
}

// pantry_items.spoonacular_ingredient_id is nullable (lazy resolution,
// migration 0007_pantry_items.sql) — matching falls back to a loose name
// comparison when it's not yet resolved, same as ranking.ts's
// pantryOverlapDeduction. amount/unit (migration 0018) are an OPTIONAL
// structured quantity -- null when a pantry entry only ever had the
// original free-text quantity_text (or no quantity at all), in which case
// this item still matches by name/id but can't be quantitatively
// subtracted (see applyPantryToLine below).
export interface PantryExclusionItem {
  name: string;
  spoonacularIngredientId: number | null;
  amount: number | null;
  unit: string | null;
  // Precomputed via lib/grocery/identityMatch.ts's resolveIdentityMatches
  // (LLM + global cache), lowercased/trimmed grocery-line names this
  // pantry item genuinely identity-matches. Used INSTEAD of the raw
  // word-boundary namesOverlap fallback below when present: namesOverlap
  // can't distinguish genuinely different products that happen to share a
  // word (pantry "green onions" wrongly matching a bare "onion" line,
  // live-confirmed 2026-07-25) -- that needs real-world grocery knowledge,
  // not a smarter string rule. undefined/null (resolution not attempted,
  // or a transient API error) falls back to namesOverlap rather than
  // matching nothing, same "never silently do less than before"
  // precedent as the rest of this file's pantry logic.
  matchedLineNames?: Set<string> | null;
}

export interface GroceryLine {
  ingredientId: number;
  name: string;
  totalAmount: number;
  unit: string;
  // PRD 7.3 F4: if measures don't reconcile across matched entries for the
  // same ingredient id, don't force a merge — list separately with a
  // "combine manually" prompt, same fallback pattern as the
  // price-unavailable case.
  needsManualCombine: boolean;
  sourceCount: number;
}

interface FlatEntry {
  id: number;
  name: string;
  amount: number;
  unit: string;
}

// Word-boundary match, not a bare bidirectional substring check — same bug
// class (and same fix) as ranking.ts's pantryOverlapDeduction and
// pantryPricePreference.ts: a bare `includes` check lets pantry "egg"
// match "eggplant" or pantry "nut" match "coconut milk". Kept as a local
// copy rather than a shared import, matching this codebase's existing
// convention of a small per-file copy over a cross-module dependency.
function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}s?\\b`).test(haystack);
}

function namesOverlap(a: string, b: string): boolean {
  return wordBoundaryIncludes(a, b) || wordBoundaryIncludes(b, a);
}

function matchesPantryItem(line: GroceryLine, item: PantryExclusionItem): boolean {
  if (item.spoonacularIngredientId !== null) {
    return line.ingredientId === item.spoonacularIngredientId;
  }
  if (item.matchedLineNames) {
    return item.matchedLineNames.has(line.name.toLowerCase().trim());
  }
  return namesOverlap(line.name.toLowerCase(), item.name.toLowerCase());
}

// "1 clove" vs "1 cloves" vs "1 Clove" should all be treated as the same
// count-style descriptor when checking whether an "other"-category pantry
// quantity is comparable to a grocery line's -- same plural-tolerance
// reasoning as wordBoundaryIncludes above, just for exact-unit comparison
// rather than substring name matching.
function normalizeOtherUnit(unit: string): string {
  return unit.toLowerCase().trim().replace(/s$/, "");
}

// A pantry item's on-hand quantity as a single shared pool that depletes
// as it's applied across grocery lines. Fixes a real bug found live
// 2026-07-25: previously each matching line drew the item's FULL declared
// amount independently (no state shared across lines), so one real pantry
// entry (e.g. "2 cloves garlic") could double- or triple-count against
// every garlic-named line this app is already known to split one
// ingredient into, instead of being spent once across their combined
// need. `category`/`otherDescriptor` are precomputed once since they
// don't change as the pool depletes; `remainingBase` is grams, ml, or a
// raw "other" count, matching whichever `category` implies.
interface PantryPool {
  item: PantryExclusionItem;
  category: UnitCategory | null; // null when the item has no usable structured quantity at all
  otherDescriptor: string | null; // set only when category === "other"
  remainingBase: number;
}

function buildPantryPools(pantryItems: PantryExclusionItem[]): PantryPool[] {
  return pantryItems.map((item) => {
    if (item.amount === null || item.unit === null) {
      return { item, category: null, otherDescriptor: null, remainingBase: 0 };
    }
    const category = classifyUnit(item.unit);
    if (category === "other") {
      return { item, category, otherDescriptor: normalizeOtherUnit(item.unit), remainingBase: item.amount };
    }
    const base = toBaseAmount(item.amount, item.unit);
    return { item, category, otherDescriptor: null, remainingBase: base ? base.baseAmount : 0 };
  });
}

// F6: reduces a grocery line by pantry quantities already on hand,
// drawing down each matching pantry item's SHARED pool (see PantryPool)
// rather than reapplying its full amount per line. Falls back to
// excluding the line ENTIRELY (the original all-or-nothing behavior) only
// when EVERY matching pantry item is structurally unusable against this
// line (no structured quantity, or an incompatible unit/descriptor) --
// fixes a second bug found live 2026-07-25 where a single unquantified
// match discarded a different, perfectly usable match's contribution for
// the same line. A pool that's merely exhausted (already spent on an
// earlier line) is left out of the sum but does NOT trigger the
// hard-exclude fallback -- it simply has nothing left to give this line.
// Distinct from F3's soft pantry-bias preference in ranking.ts's
// pantryOverlapDeduction (which only nudges recipe selection, never drops
// a slot or an ingredient).
function applyPantryToLine(line: GroceryLine, pools: PantryPool[]): GroceryLine | null {
  const lineCategory = classifyUnit(line.unit);
  const matches = pools.filter((pool) => matchesPantryItem(line, pool.item));
  if (matches.length === 0) return line;

  const usable = matches.filter(
    (pool) =>
      pool.category !== null &&
      pool.category === lineCategory &&
      (pool.category !== "other" || pool.otherDescriptor === normalizeOtherUnit(line.unit)),
  );
  if (usable.length === 0) return null; // every match is unquantified or unit-incompatible -- safe hard-exclude fallback

  let remainingNeedBase: number;
  let oneLineUnitBase = 1;
  if (lineCategory === "other") {
    remainingNeedBase = line.totalAmount;
  } else {
    const need = toBaseAmount(line.totalAmount, line.unit);
    const oneUnit = toBaseAmount(1, line.unit);
    if (!need || !oneUnit) return line; // classifyUnit already guarantees this line's unit converts
    remainingNeedBase = need.baseAmount;
    oneLineUnitBase = oneUnit.baseAmount;
  }

  for (const pool of usable) {
    if (pool.remainingBase <= 0 || remainingNeedBase <= 0) continue;
    const consumed = Math.min(pool.remainingBase, remainingNeedBase);
    pool.remainingBase -= consumed;
    remainingNeedBase -= consumed;
  }

  const remainingInLineUnit = remainingNeedBase / oneLineUnitBase;
  return remainingInLineUnit > 0 ? { ...line, totalAmount: remainingInLineUnit } : null;
}

// Exported so callers needing the identity-match pass (see
// PantryExclusionItem.matchedLineNames above) can get the raw, unexcluded
// lines first -- e.g. to list their distinct names as candidates for
// lib/grocery/identityMatch.ts's LLM/cache resolution -- and apply pantry
// exclusion in a second step once that resolution is ready. aggregateGroceryList
// below still composes both in one call for callers that don't need that split.
export function applyPantryItems(lines: GroceryLine[], pantryItems: PantryExclusionItem[]): GroceryLine[] {
  if (pantryItems.length === 0) return lines;
  const pools = buildPantryPools(pantryItems);
  const result: GroceryLine[] = [];
  for (const line of lines) {
    const adjusted = applyPantryToLine(line, pools);
    if (adjusted) result.push(adjusted);
  }
  return result;
}

function normalizeUnit(unit: string): string {
  return unit.toLowerCase().trim();
}

// Spoonacular's own extendedIngredients[].id is passed through unfiltered
// by spoonacular.ts's mapToCandidate -- and it returns a non-positive
// placeholder (confirmed live 2026-07-25: id -1 for "mayonaisse", a
// misspelling it couldn't resolve to a real ingredient) whenever it can't
// identify the ingredient at all. That placeholder is NOT unique per
// unresolved ingredient -- two DIFFERENT unrecognized ingredients in the
// same plan (e.g. a stray "or"/"garnish" fragment alongside a misspelled
// one) would both carry the same id, and grouping purely by id below would
// silently merge their amounts into one garbled, wrongly-named line.
function isValidIngredientId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

// The grouping key for an entry with a valid id is the id itself (unit
// changes, minor name variants like "onion" vs. "an onion" for the same
// real ingredient still correctly collapse together). For a placeholder
// id, the only remaining trustworthy signal is the ingredient's own name
// -- grouping by normalized name instead keeps repeat occurrences of the
// SAME unresolved ingredient (e.g. "mayonaisse" x2) correctly merged,
// while keeping DIFFERENT unresolved ingredients that happen to share the
// same placeholder id from merging into each other.
function groupingKey(entry: FlatEntry): string {
  return isValidIngredientId(entry.id) ? `id:${entry.id}` : `name:${entry.name.toLowerCase().trim()}`;
}

export function buildGroceryLines(
  slotIngredientLists: SlotIngredientEntry[][],
  addonEntries: AddonEntry[],
): GroceryLine[] {
  const flat: FlatEntry[] = [];
  for (const ingredients of slotIngredientLists) {
    for (const ing of ingredients) {
      flat.push({ id: ing.id, name: ing.name, amount: ing.metricAmount, unit: ing.metricUnit });
    }
  }
  for (const addon of addonEntries) {
    flat.push({ id: addon.ingredientId, name: addon.ingredientName, amount: addon.amountG, unit: "g" });
  }

  const groups = new Map<string, FlatEntry[]>();
  for (const entry of flat) {
    const key = groupingKey(entry);
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else groups.set(key, [entry]);
  }

  const lines: GroceryLine[] = [];
  for (const entries of groups.values()) {
    const id = entries[0].id;
    const name = entries[0].name;
    const distinctUnits = new Set(entries.map((e) => normalizeUnit(e.unit)));

    if (distinctUnits.size === 1) {
      lines.push({
        ingredientId: id,
        name,
        totalAmount: entries.reduce((sum, e) => sum + e.amount, 0),
        unit: entries[0].unit,
        needsManualCombine: false,
        sourceCount: entries.length,
      });
      continue;
    }

    // Units disagree for this ingredient id — never force a merge across
    // them. Sum within each unit instead, flagging every resulting line so
    // the UI can prompt the user to combine manually.
    const byUnit = new Map<string, FlatEntry[]>();
    for (const entry of entries) {
      const key = normalizeUnit(entry.unit);
      const existing = byUnit.get(key);
      if (existing) existing.push(entry);
      else byUnit.set(key, [entry]);
    }
    for (const group of byUnit.values()) {
      lines.push({
        ingredientId: id,
        name,
        totalAmount: group.reduce((sum, e) => sum + e.amount, 0),
        unit: group[0].unit,
        needsManualCombine: true,
        sourceCount: group.length,
      });
    }
  }

  return lines;
}

export function aggregateGroceryList(
  slotIngredientLists: SlotIngredientEntry[][],
  addonEntries: AddonEntry[],
  pantryItems: PantryExclusionItem[] = [],
): GroceryLine[] {
  return applyPantryItems(buildGroceryLines(slotIngredientLists, addonEntries), pantryItems);
}
