// Epic E2 rework (F6 Pantry Log) — read-side shape for a user's pantry
// items, shared by page.tsx (initial load) and pantryActions.ts. Not a
// Server Action file — plain data access, mirrors data.ts's pattern for
// meal plans.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PantryItemView {
  id: string;
  name: string;
  quantityText: string | null;
}

export async function getPantryItems(
  supabase: SupabaseClient,
  userId: string,
): Promise<PantryItemView[]> {
  const { data } = await supabase
    .from("pantry_items")
    .select("id, name, quantity_text")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    quantityText: row.quantity_text,
  }));
}
