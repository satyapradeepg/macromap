// Epic E2 rework (F5 Pantry Log) — read-side shape for a user's pantry
// items, shared by page.tsx (initial load) and pantryActions.ts. Not a
// Server Action file — plain data access, mirrors data.ts's pattern for
// meal plans.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PantryItemView {
  id: string;
  name: string;
  quantityText: string | null;
  // Optional structured quantity (migration 0018) — see aggregate.ts's
  // applyPantryToLine for how this lets the grocery list subtract instead
  // of dropping a whole ingredient. Independent of quantityText.
  amount: number | null;
  unit: string | null;
}

export async function getPantryItems(
  supabase: SupabaseClient,
  userId: string,
): Promise<PantryItemView[]> {
  const { data } = await supabase
    .from("pantry_items")
    .select("id, name, quantity_text, amount, unit")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    quantityText: row.quantity_text,
    amount: row.amount,
    unit: row.unit,
  }));
}
