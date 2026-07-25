"use server";

// Epic E2 rework (F6 Pantry Log) — manual add/remove Server Actions. F6 is
// fully optional (PRD 7.3): skipping pantry entry leaves generation and the
// grocery list unchanged. Entries feed F3's pantry-aware ranking
// (ranking.ts's pantryOverlapDeduction) via actions.ts's loadPantryItems —
// nothing here talks to Spoonacular directly.

import { createClient } from "@/lib/supabase/server";
import type { PantryItemView } from "./pantryData";

export interface AddPantryItemInput {
  name: string;
  quantityText: string | null;
  // Optional structured quantity (migration 0018) — lets the grocery list
  // subtract what's on hand instead of dropping a whole ingredient
  // (aggregate.ts's applyPantryToLine). Independent of quantityText, which
  // stays a free-text note; both, either, or neither may be set.
  amount: number | null;
  unit: string | null;
}

export interface AddPantryItemResult {
  item: PantryItemView | null;
  error: string | null;
}

export async function addPantryItem(input: AddPantryItemInput): Promise<AddPantryItemResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { item: null, error: "No active session — refresh the page and try again." };
  }

  const name = input.name.trim();
  if (!name) {
    return { item: null, error: "Enter an ingredient name." };
  }

  const unit = input.unit?.trim() || null;
  const amount = input.amount;
  // Require both or neither -- a lone amount/unit is an incomplete entry,
  // not a valid one, and this is the point where it's cheapest to catch.
  if ((amount !== null && !unit) || (amount === null && unit !== null)) {
    return { item: null, error: "Enter both a quantity and a unit (e.g. 2, lb), or leave both blank." };
  }
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
    return { item: null, error: "Enter a valid quantity." };
  }

  const { data, error } = await supabase
    .from("pantry_items")
    .insert({
      user_id: user.id,
      name,
      quantity_text: input.quantityText?.trim() || null,
      amount,
      unit,
    })
    .select("id, name, quantity_text, amount, unit")
    .single();

  if (error || !data) {
    return { item: null, error: error?.message ?? "Failed to add pantry item." };
  }

  return {
    item: {
      id: data.id,
      name: data.name,
      quantityText: data.quantity_text,
      amount: data.amount,
      unit: data.unit,
    },
    error: null,
  };
}

export async function removePantryItem(id: string): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "No active session — refresh the page and try again." };
  }

  // Explicit user_id scope in addition to RLS — belt-and-suspenders against
  // a client-supplied id from a different user (same defense-in-depth
  // pattern flagged as missing from swapMeal's mealPlanId, not repeated
  // here).
  const { error } = await supabase
    .from("pantry_items")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  return { error: error?.message ?? null };
}
