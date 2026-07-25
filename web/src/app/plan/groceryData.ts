// Epic E3 (F4) — read-side aggregation for a plan's grocery list. Not a
// Server Action file — plain data access, mirrors data.ts/pantryData.ts's
// pattern.
//
// Reads BOTH meal_plan_slots.ingredients (up to 35 rows/plan since
// migration 0010_snack_slots.sql widened a plan to 5 meal types x 7 days)
// AND meal_plan_slot_addons (up to 35 more, one optional row per slot) —
// an add-on is a separate table, not nested inside a slot's `ingredients`
// jsonb, so omitting it would silently under-count every plan that used
// F3's gap-closer mechanism.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyPantryItems,
  buildGroceryLines,
  conversionKey,
  mergeConvertibleLines,
  pendingCrossCategoryConversions,
  type AddonEntry,
  type PantryExclusionItem,
  type ResolvedLineConversion,
  type SlotIngredientEntry,
} from "@/lib/grocery/aggregate";
import { resolveIdentityMatches } from "@/lib/grocery/identityMatch";
import { resolveConversionRateWithSource } from "@/lib/grocery/unitConversion";
import { aisleCacheKey, resolveIngredientAisle, UNCATEGORIZED_AISLE } from "@/lib/grocery/ingredientAisle";
import { lookupIngredientPrice, type ReferenceQuantity } from "@/lib/tavily";
import { lookupIngredientCost } from "@/lib/spoonacular";
import { classifyUnit, toBaseAmount } from "@/lib/grocery/units";

export interface GroceryLineView {
  ingredientId: number;
  name: string;
  totalAmount: number;
  unit: string;
  // Grocery-store aisle/section (e.g. "Produce", "Baking") for grouping the
  // list — see lib/grocery/ingredientAisle.ts. "Other" when unresolvable.
  aisle: string;
  needsManualCombine: boolean;
  // See aggregate.ts's GroceryLine.viaAiEstimate — set when this line's
  // amount was combined across units using an AI density estimate rather
  // than Spoonacular's real conversion data.
  viaAiEstimate?: boolean;
  // null on Free tier, and on Pro tier when no price could be resolved
  // (PRD 7.3 F4: "$— Price unavailable — add manually").
  priceCents: number | null;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type PriceBasis = "per_100g" | "per_100ml" | "flat";

// A grocery line's price scales with its actual amount for weight/volume
// units (basis = cents per 100g/100ml); everything else (can, clove,
// serving, "large head", ...) is priced per unit-count instead (basis =
// cents per one count, multiplied linearly by the line's amount). Fixes
// the earlier flat-per-ingredient bug where "1.5 tsps chia seeds" was
// priced the same as a whole bag (found live 2026-07-24, $998/week total).
export function basisForUnit(unit: string): PriceBasis {
  const category = classifyUnit(unit);
  if (category === "weight") return "per_100g";
  if (category === "volume") return "per_100ml";
  return "flat";
}

function rateKey(ingredientId: number, basis: PriceBasis): string {
  return `${ingredientId}:${basis}`;
}

function computeLinePrice(rateCents: number, basis: PriceBasis, line: { totalAmount: number; unit: string }): number {
  if (basis === "flat") {
    return Math.round(rateCents * line.totalAmount);
  }
  const base = toBaseAmount(line.totalAmount, line.unit);
  // Defensive only — `basis` is derived from this exact line's unit, so
  // `toBaseAmount` always resolves here in practice.
  if (!base) return Math.round(rateCents * line.totalAmount);
  return Math.round((rateCents * base.baseAmount) / 100);
}

// grocery_price_overrides (migration 0014, widened 0016/0017) doubles as
// both the manual override store AND the 30-day Tavily-result cache (PRD
// 7.3 F4: "reused in future weeks... only re-queried if no stored
// correction exists or it's older than 30 days") — one row per (user,
// ingredient, region, basis) regardless of whether its rate came from
// Tavily or a manual edit.
async function resolvePricedLines(
  supabase: SupabaseClient,
  userId: string,
  lines: Array<Omit<GroceryLineView, "priceCents">>,
): Promise<GroceryLineView[]> {
  const { data: profile } = await supabase.from("profiles").select("zip_code").eq("id", userId).maybeSingle();
  const region = profile?.zip_code || "US";

  // Keyed by (ingredient id, basis), not just ingredient id or line — the
  // SAME ingredient can legitimately need two different rates at once,
  // since aggregate.ts splits same-id lines whenever their units disagree
  // (needsManualCombine) — confirmed live, e.g. "1.2l chicken broth" and
  // "1.3 kgs chicken broth" both appearing for one real ingredient need a
  // per_100ml rate and a per_100g rate respectively. Still deduped across
  // lines sharing both id AND basis (e.g. several bell-pepper lines that
  // are all "other"/flat) — found live 2026-07-24: a 206-line plan only
  // had 165 distinct ingredient ids, so per-LINE calls would waste ~20%
  // of Tavily credits on identical duplicate lookups.
  const nameByKey = new Map<string, string>();
  const basisByKey = new Map<string, PriceBasis>();
  const idByKey = new Map<string, number>();
  const unitByKey = new Map<string, string>();
  for (const line of lines) {
    const basis = basisForUnit(line.unit);
    const key = rateKey(line.ingredientId, basis);
    if (!nameByKey.has(key)) {
      nameByKey.set(key, line.name);
      basisByKey.set(key, basis);
      idByKey.set(key, line.ingredientId);
      unitByKey.set(key, line.unit);
    }
  }
  const keys = [...nameByKey.keys()];
  const ingredientIds = [...new Set(keys.map((key) => idByKey.get(key)!))];

  const { data: overrideRows } =
    ingredientIds.length > 0
      ? await supabase
          .from("grocery_price_overrides")
          .select("spoonacular_ingredient_id, basis, price_cents, updated_at")
          .eq("user_id", userId)
          .eq("region", region)
          .in("spoonacular_ingredient_id", ingredientIds)
      : { data: [] };

  const rateByKey = new Map<string, number>();
  for (const row of overrideRows ?? []) {
    if (Date.now() - new Date(row.updated_at).getTime() < THIRTY_DAYS_MS) {
      rateByKey.set(rateKey(row.spoonacular_ingredient_id, row.basis as PriceBasis), row.price_cents);
    }
  }

  await Promise.all(
    keys
      .filter((key) => !rateByKey.has(key))
      .map(async (key) => {
        const basis = basisByKey.get(key)!;
        const ingredientId = idByKey.get(key)!;
        const name = nameByKey.get(key)!;
        const unit = unitByKey.get(key)!.trim();

        // Spoonacular's ingredient information endpoint is the PRIMARY
        // price source (2026-07-24 switch) — a structured `estimatedCost`
        // number, not a sentence to regex a dollar figure out of. Live-
        // confirmed across weight/volume/count units, including messy real
        // ones ("large head", "clove", "servings", even a garbled
        // "2-inch"). No search call needed: every grocery line already
        // carries its resolved spoonacular_ingredient_id.
        const spoonacularAmount = basis === "flat" ? 1 : 100;
        const spoonacularUnit =
          basis === "per_100g" ? "grams" : basis === "per_100ml" ? "milliliters" : unit || undefined;

        let rateCents: number | null = null;
        try {
          const lookup = await lookupIngredientCost(ingredientId, spoonacularAmount, spoonacularUnit);
          rateCents = lookup?.costCents ?? null;
        } catch {
          rateCents = null;
        }

        // Tavily is now a fallback ONLY — used when Spoonacular genuinely
        // has no cost data for this ingredient (or is down/over quota).
        // "flat" lines get a per-unit-label query (e.g. "per serving", "per
        // can") rather than a generic price question — found live
        // (2026-07-24): a generic "average price for parmesan cheese"
        // answer is a whole-package price, and multiplying THAT by a
        // serving count badly overcounts. Falls back to the generic query
        // only when the unit string itself is unusable (bare count, unit
        // === "").
        if (rateCents === null) {
          const referenceUnit: ReferenceQuantity | undefined =
            basis === "per_100g"
              ? { type: "weight_volume", amount: 100, unit: "g" }
              : basis === "per_100ml"
                ? { type: "weight_volume", amount: 100, unit: "ml" }
                : unit
                  ? { type: "unit_label", label: unit }
                  : undefined;

          try {
            const lookup = await lookupIngredientPrice(name, region, referenceUnit);
            rateCents = lookup?.priceCents ?? null;
          } catch {
            rateCents = null;
          }
        }

        if (rateCents === null) return;

        rateByKey.set(key, rateCents);
        await supabase.from("grocery_price_overrides").upsert(
          {
            user_id: userId,
            spoonacular_ingredient_id: ingredientId,
            region,
            basis,
            price_cents: rateCents,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,spoonacular_ingredient_id,region,basis" },
        );
      }),
  );

  return lines.map((line) => {
    const basis = basisForUnit(line.unit);
    const rateCents = rateByKey.get(rateKey(line.ingredientId, basis));
    return {
      ...line,
      priceCents: rateCents === undefined ? null : computeLinePrice(rateCents, basis, line),
    };
  });
}

interface RawSlotIngredient {
  id: number;
  name: string;
  amount: number;
  unit: string;
  metricAmount: number;
  metricUnit: string;
}

export async function getGroceryList(
  supabase: SupabaseClient,
  planId: string,
  userId: string,
  tier: "free" | "pro",
): Promise<GroceryLineView[]> {
  // Explicit ownership check in addition to RLS — same defense-in-depth
  // precedent as pantryActions.ts's removePantryItem (a mismatched planId
  // for this user resolves to an empty list here rather than relying on
  // RLS alone to silently return zero rows downstream).
  const { data: plan } = await supabase
    .from("meal_plans")
    .select("id")
    .eq("id", planId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!plan) return [];

  const { data: slots } = await supabase
    .from("meal_plan_slots")
    .select("id, ingredients")
    .eq("meal_plan_id", planId);

  const slotRows = slots ?? [];
  const slotIds = slotRows.map((s) => s.id);

  const { data: addonRows } =
    slotIds.length > 0
      ? await supabase
          .from("meal_plan_slot_addons")
          .select("spoonacular_ingredient_id, ingredient_name, amount")
          .in("meal_plan_slot_id", slotIds)
      : { data: [] };

  const { data: pantryRows } = await supabase
    .from("pantry_items")
    .select("name, spoonacular_ingredient_id, amount, unit")
    .eq("user_id", userId);

  const slotIngredientLists: SlotIngredientEntry[][] = slotRows.map((row) =>
    ((row.ingredients as RawSlotIngredient[] | null) ?? []).map((ing) => ({
      id: ing.id,
      name: ing.name,
      metricAmount: ing.metricAmount,
      metricUnit: ing.metricUnit,
    })),
  );

  const addonEntries: AddonEntry[] = (addonRows ?? []).map((row) => ({
    ingredientId: row.spoonacular_ingredient_id,
    ingredientName: row.ingredient_name,
    amountG: row.amount,
  }));

  const splitLines = buildGroceryLines(slotIngredientLists, addonEntries);

  // Reconcile same-ingredient lines buildGroceryLines split apart over a
  // unit mismatch (e.g. "127.5ml vegetable stock" + "249.9g vegetable
  // stock") before anything downstream (pantry matching, pricing) ever sees
  // them as separate lines. Only the genuinely cross-category pairs need a
  // resolved rate here — same-category ones (e.g. "g" vs "kg") are handled
  // by mergeConvertibleLines itself via plain unit arithmetic.
  const pending = pendingCrossCategoryConversions(splitLines);
  const crossCategoryRates = new Map<string, ResolvedLineConversion>();
  await Promise.all(
    pending.map(async ({ ingredientId, name, sourceUnit, targetUnit }) => {
      const resolved = await resolveConversionRateWithSource(name, sourceUnit, targetUnit);
      if (resolved) crossCategoryRates.set(conversionKey(ingredientId, sourceUnit, targetUnit), resolved);
    }),
  );
  const rawLines = mergeConvertibleLines(splitLines, crossCategoryRates);

  // Identity-match resolution only matters for pantry items that don't
  // already have a resolved id -- an id match in aggregate.ts's
  // matchesPantryItem short-circuits before ever consulting
  // matchedLineNames. Resolved in parallel across pantry items (typically
  // few) against this plan's actual distinct line names -- most calls hit
  // the global cache (identityMatch.ts) once the common ingredient
  // vocabulary has been seen once, so this stays fast after warm-up.
  const distinctLineNames = [...new Set(rawLines.map((l) => l.name))];
  const rawPantryRows = pantryRows ?? [];
  const matchedLineNamesByRow = await Promise.all(
    rawPantryRows.map((row) =>
      row.spoonacular_ingredient_id === null
        ? resolveIdentityMatches(row.name, distinctLineNames)
        : Promise.resolve(null),
    ),
  );

  // Cross-category conversion (e.g. a pantry entry in ml crediting a
  // matched line that needs grams of the same ingredient) only matters
  // for quantified pantry items whose matched lines include at least one
  // line outside the item's own unit category/descriptor -- unquantified
  // items and same-category matches already resolve inside aggregate.ts.
  // Resolved in parallel across pantry items, each against only the
  // distinct target units it actually needs (typically 0-2), so this
  // stays cheap even before the global cache in unitConversion.ts warms up.
  const unitConversionRatesByRow = await Promise.all(
    rawPantryRows.map(async (row, i) => {
      if (row.amount === null || row.unit === null) return null;
      const matchedNames = matchedLineNamesByRow[i];
      if (!matchedNames || matchedNames.size === 0) return null;

      const itemCategory = classifyUnit(row.unit);
      const sourceUnit = itemCategory === "weight" ? "g" : itemCategory === "volume" ? "ml" : row.unit;
      const itemDescriptor = itemCategory === "other" ? row.unit.toLowerCase().trim().replace(/s$/, "") : null;

      const targetUnits = new Set(
        rawLines
          .filter((line) => matchedNames.has(line.name.toLowerCase().trim()))
          .map((line) => ({ unit: line.unit, category: classifyUnit(line.unit) }))
          .filter(
            (line) =>
              line.category !== itemCategory ||
              (itemCategory === "other" && line.unit.toLowerCase().trim().replace(/s$/, "") !== itemDescriptor),
          )
          .map((line) => line.unit.toLowerCase().trim()),
      );
      if (targetUnits.size === 0) return null;

      const rates = new Map<string, ResolvedLineConversion>();
      await Promise.all(
        [...targetUnits].map(async (targetUnit) => {
          const resolved = await resolveConversionRateWithSource(row.name, sourceUnit, targetUnit);
          if (resolved) rates.set(targetUnit, resolved);
        }),
      );
      return rates.size > 0 ? rates : null;
    }),
  );

  const pantryItems: PantryExclusionItem[] = rawPantryRows.map((row, i) => ({
    name: row.name,
    spoonacularIngredientId: row.spoonacular_ingredient_id,
    amount: row.amount,
    unit: row.unit,
    matchedLineNames: matchedLineNamesByRow[i],
    unitConversionRates: unitConversionRatesByRow[i],
  }));

  const excludedLines = applyPantryItems(rawLines, pantryItems);

  // Deduped by the SAME cache-key convention resolveIngredientAisle itself
  // uses (id when resolved, else normalized name) -- a real plan can have
  // far fewer distinct ingredients than lines (aggregate.ts splits a same-
  // id group whenever units disagree), same dedup reasoning as
  // resolvePricedLines above.
  const aisleByKey = new Map<string, string>();
  await Promise.all(
    [...new Map(excludedLines.map((l) => [aisleCacheKey(l.ingredientId, l.name), l])).values()].map(
      async (line) => {
        const resolved = await resolveIngredientAisle(line.ingredientId, line.name);
        aisleByKey.set(aisleCacheKey(line.ingredientId, line.name), resolved?.aisle ?? UNCATEGORIZED_AISLE);
      },
    ),
  );

  const lines = excludedLines
    .map((line) => ({
      ingredientId: line.ingredientId,
      name: line.name,
      totalAmount: line.totalAmount,
      unit: line.unit,
      aisle: aisleByKey.get(aisleCacheKey(line.ingredientId, line.name)) ?? UNCATEGORIZED_AISLE,
      needsManualCombine: line.needsManualCombine,
      viaAiEstimate: line.viaAiEstimate,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (tier !== "pro") {
    return lines.map((line) => ({ ...line, priceCents: null }));
  }

  return resolvePricedLines(supabase, userId, lines);
}
