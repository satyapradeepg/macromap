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

  const { data, error } = await supabase
    .from("pantry_items")
    .insert({
      user_id: user.id,
      name,
      quantity_text: input.quantityText?.trim() || null,
    })
    .select("id, name, quantity_text")
    .single();

  if (error || !data) {
    return { item: null, error: error?.message ?? "Failed to add pantry item." };
  }

  return {
    item: { id: data.id, name: data.name, quantityText: data.quantity_text },
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
