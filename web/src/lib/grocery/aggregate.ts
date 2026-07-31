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
  // Precomputed via lib/grocery/unitConversion.ts's resolveConversionRate
  // (Spoonacular's real density-aware /recipes/convert endpoint + a
  // global cache), keyed by a matched grocery line's lowercased/trimmed
  // unit string, value = how many of that unit equal one unit of this
  // pantry item's own base (grams/ml for weight/volume, or this item's
  // own declared unit for "other"). Lets a category-mismatched-but-
  // quantified match (e.g. pantry "500ml greek yogurt" vs. a line needing
  // grams) still contribute instead of hard-excluding the line outright
  // regardless of amount -- found live 2026-07-25 that the pre-fix
  // behavior let a volume-only pantry entry silently zero out an
  // unrelated weight-based need for the same ingredient. Absent/no entry
  // for a given unit falls back to the safe hard-exclude, same "never do
  // worse than before" precedent as matchedLineNames above.
  unitConversionRates?: Map<string, ResolvedLineConversion> | null;
}

export interface GroceryLine {
  ingredientId: number;
  name: string;
  totalAmount: number;
  unit: string;
  // PRD 7.3 F4: if measures don't reconcile across matched entries for the
  // same ingredient id, don't force a merge — list separately with a
  // "combine manually" prompt, same fallback pattern as the
  // price-unavailable case. mergeConvertibleLines (below) now resolves most
  // of these before this flag is ever shown to the user — it survives to
  // true only when no same-category arithmetic AND no cross-category
  // conversion (Spoonacular density, or its AI-estimate fallback) could
  // reconcile every sibling line for this ingredient id.
  needsManualCombine: boolean;
  sourceCount: number;
  // Set when this line's amount includes at least one cross-category
  // (weight<->volume, or other<->weight/volume) conversion that came from
  // unitConversion.ts's AI density-estimate fallback rather than
  // Spoonacular's real /recipes/convert data -- lets the UI flag it as
  // worth a quick double-check, same "never let a guess look identical to
  // verified data" precedent as PlanView.tsx's "AI-composed" slot label.
  viaAiEstimate?: boolean;
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
// line (no structured quantity, or an incompatible/unconvertible unit) --
// fixes a second bug found live 2026-07-25 where a single unquantified
// match discarded a different, perfectly usable match's contribution for
// the same line. A pool that's merely exhausted (already spent on an
// earlier line) is left out of the sum but does NOT trigger the
// hard-exclude fallback -- it simply has nothing left to give this line.
// Distinct from F3's soft pantry-bias preference in ranking.ts's
// pantryOverlapDeduction (which only nudges recipe selection, never drops
// a slot or an ingredient).
//
// Every usable pool contributes via one rate: how many of THIS LINE's
// unit equal one unit of the pool's own base. Same-category matches get
// a rate derived from the existing weight/volume conversion table (or 1,
// once "other" descriptors are confirmed equal); cross-category matches
// get a rate from PantryExclusionItem.unitConversionRates (a real,
// ingredient-specific density lookup precomputed in groceryData.ts) when
// available -- e.g. a pantry entry declared in ml can now credit a line
// that needs grams of the SAME ingredient, instead of the pre-fix
// behavior of hard-excluding it outright regardless of amount (found
// live 2026-07-25: a volume-only "greek yogurt" pantry entry silently
// zeroed out an unrelated 825g weight-based need for the same
// ingredient, from a different recipe, elsewhere in the same plan).
// Tracking `remainingNeed` in the line's own unit throughout (rather than
// converting everything into a shared weight/volume base up front) is
// what lets same-category and cross-category pools mix in one loop.
function applyPantryToLine(line: GroceryLine, pools: PantryPool[]): GroceryLine | null {
  const lineCategory = classifyUnit(line.unit);
  const matches = pools.filter((pool) => matchesPantryItem(line, pool.item));
  if (matches.length === 0) return line;

  const usable: Array<{ pool: PantryPool; lineUnitsPerPoolBase: number; viaAiEstimate: boolean }> = [];
  for (const pool of matches) {
    if (pool.category === null) continue;

    if (pool.category === lineCategory) {
      if (pool.category === "other") {
        if (pool.otherDescriptor === normalizeOtherUnit(line.unit)) {
          usable.push({ pool, lineUnitsPerPoolBase: 1, viaAiEstimate: false });
        }
        continue;
      }
      const oneLineUnitBase = toBaseAmount(1, line.unit);
      if (oneLineUnitBase && oneLineUnitBase.baseAmount > 0) {
        usable.push({ pool, lineUnitsPerPoolBase: 1 / oneLineUnitBase.baseAmount, viaAiEstimate: false });
      }
      continue;
    }

    const resolved = pool.item.unitConversionRates?.get(line.unit.toLowerCase().trim());
    if (resolved) {
      usable.push({ pool, lineUnitsPerPoolBase: resolved.rate, viaAiEstimate: resolved.source === "ai_estimate" });
    }
  }
  if (usable.length === 0) return null; // no usable or convertible match -- safe hard-exclude fallback

  let remainingNeed = line.totalAmount;
  // Same "never let an AI guess look identical to verified data" precedent
  // as mergeConvertibleLines -- only set when a pool actually CONSUMED some
  // of this line's need via an AI-estimated rate (a merely-available but
  // unused pool, e.g. already exhausted by an earlier line, shouldn't taint
  // the flag).
  let usedAiEstimate = false;
  for (const { pool, lineUnitsPerPoolBase, viaAiEstimate } of usable) {
    if (pool.remainingBase <= 0 || remainingNeed <= 0) continue;
    const maxConsumableInLineUnits = pool.remainingBase * lineUnitsPerPoolBase;
    const consumedInLineUnits = Math.min(maxConsumableInLineUnits, remainingNeed);
    if (consumedInLineUnits > 0 && viaAiEstimate) usedAiEstimate = true;
    pool.remainingBase -= consumedInLineUnits / lineUnitsPerPoolBase;
    remainingNeed -= consumedInLineUnits;
  }

  if (remainingNeed <= 0) return null;
  return {
    ...line,
    totalAmount: remainingNeed,
    viaAiEstimate: usedAiEstimate || line.viaAiEstimate ? true : undefined,
  };
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

// Strips a single trailing "s" so mergeConvertibleLines' "other"-category
// reconciliation (below) can recognize "clove"/"cloves", "serving"/
// "servings" etc. as the same real unit -- never applied to a blank unit
// (already handled separately) or used to compare two DIFFERENT words
// (e.g. "clove" vs "slice" still correctly stay distinct, since their
// stems differ too).
function stemOtherUnit(normalizedUnit: string): string {
  return normalizedUnit.endsWith("s") && normalizedUnit.length > 1 ? normalizedUnit.slice(0, -1) : normalizedUnit;
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

// Reuses this file's own wordBoundaryIncludes/namesOverlap (already
// defined above for pantry matching) -- decides whether two entries
// sharing a Spoonacular ingredient id are even PLAUSIBLY the same
// purchasable item before grouping/summing them at all. Spoonacular's own
// ingredient-text parser can resolve a completely different mention to
// an established product's id -- live-confirmed 2026-07-31: "gluten" (a
// bread recipe's small vital-wheat-gluten additive, ~1.6 Tbsp) resolved
// to id 93654, which Spoonacular's own /information endpoint confirms is
// canonically "seitan cutlets" (category "meat substitute"). groupingKey
// above trusts the id alone, so this silently summed that 1.6 Tbsp into
// ~1.7kg of real seitan-cutlets servings from other meals, picked "Tbsp"
// as the display unit for the combined pile, and labeled the whole
// absurd result "gluten" (whichever entry happened to be first) --
// rendered live as "122 Tbsps gluten". This is a cheap, zero-cost
// plausibility gate: it can only ever SPLIT a group that would otherwise
// merge, never merge one that wouldn't have -- a false split just leaves
// two correctly-named separate lines instead of one combined line, same
// "never do worse than the pre-fix all-or-nothing split" precedent as
// the rest of this file.
//
// Re-partitions one groupingKey bucket into name-compatible clusters via
// union-find over namesOverlap (same shape as lineIdentity.ts's
// buildNameComponents) -- a bucket of entries that all share one exact
// normalized name (the placeholder-id case) or all genuinely name-overlap
// (the common, correct id case) comes back as a single cluster, a no-op.
// Only a bucket like [gluten, seitan cutlets, seitan cutlets, ...] -- zero
// word overlap between "gluten" and the rest -- splits into more than one.
// Generic over FlatEntry (buildGroceryLines' input, pre-merge) AND
// GroceryLine (mergeConvertibleLines' input, post-split) -- both carry a
// plain `name` field, and BOTH stages independently group by ingredientId
// from scratch, so both need this same gate. Fixing only buildGroceryLines
// wasn't enough on its own: it correctly splits gluten/seitan cutlets into
// two separate GroceryLines, but mergeConvertibleLines then re-groups
// EVERY line by ingredientId again (its own independent pass, oblivious to
// names), sees the same id 93654 on both, and merges them right back
// together via the cross-category AI-density path -- live-confirmed this
// exact double-merge while verifying the fix.
function clusterByNameOverlap<T extends { name: string }>(entries: T[]): T[][] {
  if (entries.length <= 1) return [entries];
  const parent = entries.map((_, i) => i);
  function find(x: number): number {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let cur = x;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (namesOverlap(entries[i].name.toLowerCase(), entries[j].name.toLowerCase())) union(i, j);
    }
  }
  const clusters = new Map<number, T[]>();
  for (let i = 0; i < entries.length; i++) {
    const root = find(i);
    const existing = clusters.get(root);
    if (existing) existing.push(entries[i]);
    else clusters.set(root, [entries[i]]);
  }
  return [...clusters.values()];
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

  const rawGroups = new Map<string, FlatEntry[]>();
  for (const entry of flat) {
    const key = groupingKey(entry);
    const existing = rawGroups.get(key);
    if (existing) existing.push(entry);
    else rawGroups.set(key, [entry]);
  }
  // Re-partition each id-based bucket by name overlap before trusting it
  // as one real ingredient -- see clusterByNameOverlap's comment. A
  // placeholder-id bucket (already scoped to one exact normalized name)
  // always comes back as a single cluster, so this is safe to apply
  // universally rather than special-casing which buckets need it.
  const groups: FlatEntry[][] = [];
  for (const bucket of rawGroups.values()) {
    groups.push(...clusterByNameOverlap(bucket));
  }

  const lines: GroceryLine[] = [];
  for (const entries of groups) {
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

// Keyed lookup format shared by pendingCrossCategoryConversions (which asks
// for exactly the rates a merge will need) and mergeConvertibleLines (which
// consumes them) — kept as one function so the two can never drift apart on
// key shape.
export function conversionKey(ingredientId: number, sourceUnit: string, targetUnit: string): string {
  return `${ingredientId}:${normalizeUnit(sourceUnit)}:${normalizeUnit(targetUnit)}`;
}

interface UnitMergeGroup {
  target: GroceryLine;
  rest: GroceryLine[];
}

// Same-ingredient-id lines with disagreeing units always arrive as
// consecutive entries from buildGroceryLines' byUnit split above — grouping
// by id and picking the first as the merge target keeps a deterministic,
// order-independent choice (which specific line ends up "target" doesn't
// matter; every other line converts INTO it).
function groupForMerge(lines: GroceryLine[]): UnitMergeGroup[] {
  const groups = new Map<number, GroceryLine[]>();
  const order: number[] = [];
  for (const line of lines) {
    if (!groups.has(line.ingredientId)) {
      groups.set(line.ingredientId, []);
      order.push(line.ingredientId);
    }
    groups.get(line.ingredientId)!.push(line);
  }
  return order
    .map((id) => groups.get(id)!)
    .flatMap((group) => clusterByNameOverlap(group))
    .filter((group) => group.length > 1)
    .map(([target, ...rest]) => ({ target, rest }));
}

// Exported so groceryData.ts can resolve exactly (and only) the
// cross-category conversion rates a merge will actually need — via
// unitConversion.ts's resolveConversionRateWithSource (Spoonacular density,
// falling back to an AI estimate) — before calling mergeConvertibleLines.
// Same "resolve first (network/AI), merge second (pure)" split this file
// already uses for pantry cross-category crediting. Same-category
// mismatches (e.g. "g" vs "kg") aren't included here — mergeConvertibleLines
// resolves those itself via plain unit arithmetic, no lookup needed.
export function pendingCrossCategoryConversions(
  lines: GroceryLine[],
): Array<{ ingredientId: number; name: string; sourceUnit: string; targetUnit: string }> {
  const pending: Array<{ ingredientId: number; name: string; sourceUnit: string; targetUnit: string }> = [];
  for (const { target, rest } of groupForMerge(lines)) {
    const targetCategory = classifyUnit(target.unit);
    for (const line of rest) {
      if (classifyUnit(line.unit) !== targetCategory) {
        pending.push({ ingredientId: target.ingredientId, name: target.name, sourceUnit: line.unit, targetUnit: target.unit });
      }
    }
  }
  return pending;
}

export interface ResolvedLineConversion {
  rate: number; // how many of the target line's unit equal one of the source line's unit, for this ingredient
  source: "spoonacular" | "ai_estimate";
}

// Reconciles same-ingredient-id lines that buildGroceryLines split apart
// over a unit mismatch. Same-category disagreements (both weight, e.g. "g"
// vs "kg", or both volume, e.g. "tsp" vs "cup") always resolve via plain
// unit arithmetic (toBaseAmount) — free, no lookup, always succeeds.
// Cross-category disagreements (weight vs volume, or either vs an "other"
// count like "clove") need an ingredient-specific rate, supplied by the
// caller via `crossCategoryRates` (see pendingCrossCategoryConversions).
// Whatever can't be resolved — an unconvertible pair (e.g. "clove" vs
// "slice", both "other"), or a cross-category pair with no rate available —
// is left as its own line, still flagged needsManualCombine, same "never do
// worse than the pre-fix all-or-nothing split" precedent as this file's
// pantry logic. The target line itself only drops needsManualCombine once
// EVERY sibling line for that ingredient id has been folded in.
export function mergeConvertibleLines(
  lines: GroceryLine[],
  crossCategoryRates: Map<string, ResolvedLineConversion>,
): GroceryLine[] {
  const groups = new Map<number, GroceryLine[]>();
  const order: number[] = [];
  for (const line of lines) {
    if (!groups.has(line.ingredientId)) {
      groups.set(line.ingredientId, []);
      order.push(line.ingredientId);
    }
    groups.get(line.ingredientId)!.push(line);
  }
  // Independent grouping pass from buildGroceryLines/groupForMerge above --
  // re-applies the same name-overlap gate here too, or a same-id pair that
  // buildGroceryLines correctly split apart (e.g. gluten vs. seitan
  // cutlets) gets silently re-merged right back together by THIS pass,
  // which otherwise only ever looks at ingredientId. Live-confirmed this
  // exact double-merge while verifying the fix -- see clusterByNameOverlap's
  // comment.
  const clusters = order.flatMap((id) => clusterByNameOverlap(groups.get(id)!));

  const result: GroceryLine[] = [];
  for (const group of clusters) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    const [target, ...rest] = group;
    const targetCategory = classifyUnit(target.unit);
    let mergedAmount = target.totalAmount;
    let mergedSourceCount = target.sourceCount;
    let usedAiEstimate = false;
    const unresolved: GroceryLine[] = [];

    for (const line of rest) {
      const lineCategory = classifyUnit(line.unit);
      let convertedAmount: number | null = null;

      if (lineCategory === targetCategory && targetCategory === "other") {
        // A blank unit (Spoonacular sometimes omits a size qualifier
        // entirely) and a named size descriptor ("medium", "large", ...)
        // for the SAME ingredient id both mean "one whole item" -- live-
        // found 2026-07-25: real plan data had one ingredient id ("onion")
        // split across a blank-unit line and a "medium"-unit line that
        // were clearly the same ingredient, never merging (buildGroceryLines
        // splits by exact unit STRING, and "" !== "medium"). Treating a
        // blank unit as compatible with any ONE other descriptor closes
        // that gap. Two DIFFERENT named descriptors (e.g. "medium" vs
        // "large") are deliberately NOT assumed equivalent -- a real size
        // difference -- and fall through to unresolved, same as "clove"
        // vs "slice" always has.
        const targetNorm = normalizeUnit(target.unit);
        const lineNorm = normalizeUnit(line.unit);
        const targetIsBlank = targetNorm === "";
        const lineIsBlank = lineNorm === "";
        if (targetIsBlank !== lineIsBlank) {
          convertedAmount = line.totalAmount;
        } else if (!targetIsBlank && !lineIsBlank && stemOtherUnit(targetNorm) === stemOtherUnit(lineNorm)) {
          // Singular/plural spelling of the identical unit word (e.g.
          // "clove" vs "cloves", "serving" vs "servings") -- found live
          // 2026-07-27 (groceryCritic.ts's first real trial): a genuine 1:1
          // unit, not a size difference like "medium" vs "large" or a
          // different word entirely like "clove" vs "slice" (both still
          // correctly fall through to unresolved below, since their stems
          // differ). Same singular/plural asymmetry class already fixed
          // for the dislike/allergy word-boundary matcher this same
          // session -- this is the grocery-aggregation sibling of that fix.
          convertedAmount = line.totalAmount;
        }
      } else if (lineCategory === targetCategory) {
        const targetUnitBase = toBaseAmount(1, target.unit)!;
        const lineBase = toBaseAmount(line.totalAmount, line.unit)!;
        convertedAmount = lineBase.baseAmount / targetUnitBase.baseAmount;
      } else {
        const resolved = crossCategoryRates.get(conversionKey(target.ingredientId, line.unit, target.unit));
        if (resolved) {
          convertedAmount = line.totalAmount * resolved.rate;
          if (resolved.source === "ai_estimate") usedAiEstimate = true;
        }
      }

      if (convertedAmount !== null) {
        mergedAmount += convertedAmount;
        mergedSourceCount += line.sourceCount;
      } else {
        unresolved.push(line);
      }
    }

    result.push({
      ...target,
      totalAmount: mergedAmount,
      sourceCount: mergedSourceCount,
      needsManualCombine: unresolved.length > 0,
      viaAiEstimate: usedAiEstimate || undefined,
    });
    result.push(...unresolved);
  }

  return result;
}

export function aggregateGroceryList(
  slotIngredientLists: SlotIngredientEntry[][],
  addonEntries: AddonEntry[],
  pantryItems: PantryExclusionItem[] = [],
): GroceryLine[] {
  return applyPantryItems(buildGroceryLines(slotIngredientLists, addonEntries), pantryItems);
}
