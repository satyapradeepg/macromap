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
// pantryOverlapDeduction.
export interface PantryExclusionItem {
  name: string;
  spoonacularIngredientId: number | null;
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

// F6: pantry contents are excluded from the grocery list ENTIRELY — a hard
// exclude, distinct from F3's soft pantry-bias preference in ranking.ts's
// pantryOverlapDeduction (which only nudges recipe selection, never drops
// a slot or an ingredient).
function excludePantryItems(lines: GroceryLine[], pantryItems: PantryExclusionItem[]): GroceryLine[] {
  if (pantryItems.length === 0) return lines;
  return lines.filter((line) => !pantryItems.some((item) => matchesPantryItem(line, item)));
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

  return excludePantryItems(lines, pantryItems);
}
