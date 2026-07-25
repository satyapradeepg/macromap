"use server";

// Epic E3 (F4) — fetchGroceryList is a read-side action so the client can
// refresh the grocery list whenever the plan changes (fresh generation or
// a single-slot swap), without a full page reload. Mirrors
// pantryActions.ts's session-check convention; the actual aggregation and
// pricing live in groceryData.ts.

import { createClient } from "@/lib/supabase/server";
import { getGroceryList, basisForUnit, type GroceryLineView } from "./groceryData";
import { toBaseAmount } from "@/lib/grocery/units";

async function loadTier(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<"free" | "pro"> {
  const { data: profile } = await supabase.from("profiles").select("tier").eq("id", userId).maybeSingle();
  return profile?.tier ?? "free";
}

export interface FetchGroceryListResult {
  lines: GroceryLineView[];
  error: string | null;
}

export async function fetchGroceryList(planId: string): Promise<FetchGroceryListResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { lines: [], error: "No active session — refresh the page and try again." };
  }

  const tier = await loadTier(supabase, user.id);
  const lines = await getGroceryList(supabase, planId, user.id, tier);
  return { lines, error: null };
}

export interface OverrideGroceryPriceInput {
  ingredientId: number;
  // What the user says THIS line (its current amount/unit) costs, total —
  // matches the UX of typing "what this costs me," not an abstract rate.
  priceCents: number;
  totalAmount: number;
  unit: string;
}

// Pro tier only (PRD 7.3 F4: "Manual price override available per item").
// Writes into the same grocery_price_overrides row the Tavily-cache path
// uses (migration 0014/0016/0017) — a manual correction and a cached
// lookup are the same mechanism, just a different source for one write.
// Stored as a RATE (cents per 100g/100ml, or a flat per-unit-count price),
// not the raw total the user typed, so it reapplies correctly if the same
// ingredient shows up in a different amount next week — the same fix
// applied to the Tavily path in groceryData.ts's resolvePricedLines.
export async function overrideGroceryPrice(input: OverrideGroceryPriceInput): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "No active session — refresh the page and try again." };
  }

  if (!Number.isFinite(input.priceCents) || input.priceCents < 0) {
    return { error: "Enter a valid price." };
  }
  if (!Number.isFinite(input.totalAmount) || input.totalAmount <= 0) {
    return { error: "Invalid quantity for this line." };
  }

  const basis = basisForUnit(input.unit);
  let rateCents: number;
  if (basis === "flat") {
    rateCents = Math.round(input.priceCents / input.totalAmount);
  } else {
    // Non-null: `basis` was just derived from this same `input.unit`.
    const base = toBaseAmount(input.totalAmount, input.unit)!;
    rateCents = Math.round((input.priceCents * 100) / base.baseAmount);
  }

  const { data: profile } = await supabase.from("profiles").select("zip_code").eq("id", user.id).maybeSingle();
  const region = profile?.zip_code || "US";

  const { error } = await supabase.from("grocery_price_overrides").upsert(
    {
      user_id: user.id,
      spoonacular_ingredient_id: input.ingredientId,
      region,
      basis,
      price_cents: rateCents,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,spoonacular_ingredient_id,region,basis" },
  );

  return { error: error?.message ?? null };
}
