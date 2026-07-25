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

import { classifyUnit, toBaseAmount } from "./units";

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

// Returns how much of a grocery line's need one pantry item covers,
// expressed in the LINE's own unit -- or null when the two genuinely can't
// be compared (no structured quantity on the pantry item, different unit
// categories, or same "other" category but a different descriptor, e.g.
// pantry "1 bag" flour vs. a line in "cups"). Never guesses across an
// unconvertible pair: the caller falls back to a hard exclude in that
// case, exactly as if no quantity had been given at all.
function pantryContributionInLineUnit(item: PantryExclusionItem, line: GroceryLine): number | null {
  if (item.amount === null || item.unit === null) return null;

  const pantryCategory = classifyUnit(item.unit);
  const lineCategory = classifyUnit(line.unit);
  if (pantryCategory !== lineCategory) return null;

  if (pantryCategory === "other") {
    if (normalizeOtherUnit(item.unit) !== normalizeOtherUnit(line.unit)) return null;
    return item.amount; // same descriptor -- counts are directly comparable
  }

  const pantryBase = toBaseAmount(item.amount, item.unit);
  const oneLineUnitInBase = toBaseAmount(1, line.unit);
  if (!pantryBase || !oneLineUnitInBase || oneLineUnitInBase.baseAmount === 0) return null;
  return pantryBase.baseAmount / oneLineUnitInBase.baseAmount;
}

// F6: reduces a grocery line by pantry quantities already on hand when
// they're genuinely comparable to the line's unit; falls back to
// excluding the line ENTIRELY (the original all-or-nothing behavior, kept
// for every case a structured quantity can't settle) when any matching
// pantry item lacks a structured amount/unit or its unit can't be
// compared. Distinct from F3's soft pantry-bias preference in ranking.ts's
// pantryOverlapDeduction (which only nudges recipe selection, never drops
// a slot or an ingredient).
function applyPantryToLine(line: GroceryLine, pantryItems: PantryExclusionItem[]): GroceryLine | null {
  const matches = pantryItems.filter((item) => matchesPantryItem(line, item));
  if (matches.length === 0) return line;

  let totalContribution = 0;
  for (const item of matches) {
    const contribution = pantryContributionInLineUnit(item, line);
    if (contribution === null) return null; // hard exclude -- unconvertible or unquantified match
    totalContribution += contribution;
  }

  const remaining = line.totalAmount - totalContribution;
  return remaining > 0 ? { ...line, totalAmount: remaining } : null;
}

function applyPantryItems(lines: GroceryLine[], pantryItems: PantryExclusionItem[]): GroceryLine[] {
  if (pantryItems.length === 0) return lines;
  const result: GroceryLine[] = [];
  for (const line of lines) {
    const adjusted = applyPantryToLine(line, pantryItems);
    if (adjusted) result.push(adjusted);
  }
  return result;
}

function normalizeUnit(unit: string): string {
  return unit.toLowerCase().trim();
}

export function aggregateGroceryList(
  slotIngredientLists: SlotIngredientEntry[][],
  addonEntries: AddonEntry[],
  pantryItems: PantryExclusionItem[] = [],
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

  const groups = new Map<number, FlatEntry[]>();
  for (const entry of flat) {
    const existing = groups.get(entry.id);
    if (existing) existing.push(entry);
    else groups.set(entry.id, [entry]);
  }

  const lines: GroceryLine[] = [];
  for (const [id, entries] of groups) {
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

  return applyPantryItems(lines, pantryItems);
}
