import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client for tables with NO per-user owner and a default-deny
// RLS policy set: public.recipe_query_cache (0006) and
// public.ingredient_identity_matches (0019) — only this client (which
// bypasses RLS entirely) can read/write either. Never use this for
// profiles/meal_plans/meal_plan_slots/pantry_items — those must keep going
// through src/lib/supabase/server.ts so per-user RLS stays enforced.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}
