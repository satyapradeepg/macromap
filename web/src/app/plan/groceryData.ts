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
  aggregateGroceryList,
  type AddonEntry,
  type PantryExclusionItem,
  type SlotIngredientEntry,
} from "@/lib/grocery/aggregate";
import { lookupIngredientPrice } from "@/lib/tavily";

export interface GroceryLineView {
  ingredientId: number;
  name: string;
  totalAmount: number;
  unit: string;
  needsManualCombine: boolean;
  // null on Free tier, and on Pro tier when no price could be resolved
  // (PRD 7.3 F4: "$— Price unavailable — add manually").
  priceCents: number | null;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// grocery_price_overrides (migration 0014) doubles as both the manual
// override store AND the 30-day Tavily-result cache (PRD 7.3 F4: "reused
// in future weeks... only re-queried if no stored correction exists or
// it's older than 30 days") — one row per (user, ingredient, region)
// regardless of whether its price came from Tavily or a manual edit.
async function resolvePricedLines(
  supabase: SupabaseClient,
  userId: string,
  lines: Array<Omit<GroceryLineView, "priceCents">>,
): Promise<GroceryLineView[]> {
  const { data: profile } = await supabase.from("profiles").select("zip_code").eq("id", userId).maybeSingle();
  const region = profile?.zip_code || "US";

  // Keyed by DISTINCT ingredient id, not by line — a unit-mismatch split
  // (aggregate.ts) can produce several grocery lines for the same real
  // ingredient (e.g. "1 medium bell pepper" / "1 bell pepper" / "2
  // servings bell pepper"), and firing one Tavily call per LINE would
  // silently multiply real credit spend for the identical price. Found
  // live (2026-07-24): a 206-line plan only had 165 distinct ingredient
  // ids, so the naive per-line version was burning ~20% more Tavily
  // credits than necessary for zero benefit.
  const nameByIngredientId = new Map<number, string>();
  for (const line of lines) {
    if (!nameByIngredientId.has(line.ingredientId)) {
      nameByIngredientId.set(line.ingredientId, line.name);
    }
  }
  const ingredientIds = [...nameByIngredientId.keys()];

  const { data: overrideRows } =
    ingredientIds.length > 0
      ? await supabase
          .from("grocery_price_overrides")
          .select("spoonacular_ingredient_id, price_cents, updated_at")
          .eq("user_id", userId)
          .eq("region", region)
          .in("spoonacular_ingredient_id", ingredientIds)
      : { data: [] };

  const priceByIngredientId = new Map<number, number>();
  for (const row of overrideRows ?? []) {
    if (Date.now() - new Date(row.updated_at).getTime() < THIRTY_DAYS_MS) {
      priceByIngredientId.set(row.spoonacular_ingredient_id, row.price_cents);
    }
  }

  await Promise.all(
    ingredientIds
      .filter((id) => !priceByIngredientId.has(id))
      .map(async (id) => {
        // A Tavily outage/quota error degrades this one ingredient to
        // "price unavailable" rather than failing the whole grocery list
        // — same graceful-degradation precedent as F3's
        // Spoonacular-outage cached-plan fallback.
        let priceCents: number | null = null;
        try {
          const lookup = await lookupIngredientPrice(nameByIngredientId.get(id)!, region);
          priceCents = lookup?.priceCents ?? null;
        } catch {
          priceCents = null;
        }
        if (priceCents === null) return;

        priceByIngredientId.set(id, priceCents);
        await supabase.from("grocery_price_overrides").upsert(
          {
            user_id: userId,
            spoonacular_ingredient_id: id,
            region,
            price_cents: priceCents,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,spoonacular_ingredient_id,region" },
        );
      }),
  );

  return lines.map((line) => ({ ...line, priceCents: priceByIngredientId.get(line.ingredientId) ?? null }));
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
    .select("name, spoonacular_ingredient_id")
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

  const pantryItems: PantryExclusionItem[] = (pantryRows ?? []).map((row) => ({
    name: row.name,
    spoonacularIngredientId: row.spoonacular_ingredient_id,
  }));

  const lines = aggregateGroceryList(slotIngredientLists, addonEntries, pantryItems)
    .map((line) => ({
      ingredientId: line.ingredientId,
      name: line.name,
      totalAmount: line.totalAmount,
      unit: line.unit,
      needsManualCombine: line.needsManualCombine,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (tier !== "pro") {
    return lines.map((line) => ({ ...line, priceCents: null }));
  }

  return resolvePricedLines(supabase, userId, lines);
}
