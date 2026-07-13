import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client for public.recipe_query_cache ONLY (see
// supabase/migrations/0006_recipe_query_cache.sql) — this table has no
// per-user owner and its RLS policy set is default-deny, so only this
// client (which bypasses RLS entirely) can read/write it. Never use this
// for profiles/meal_plans/meal_plan_slots — those must keep going through
// src/lib/supabase/server.ts so per-user RLS stays enforced.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}
