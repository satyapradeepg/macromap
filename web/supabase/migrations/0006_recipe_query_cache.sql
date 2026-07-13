-- Cross-user Spoonacular query-result cache (ai-agents.md Agent 2, the
-- "cross-user query-result cache" half of its two-cache split — the other
-- half, the per-user last-successful-plan cache, is just meal_plans'
-- most-recent row, see 0005). Keyed on the shared constraint tuple +
-- tolerance tier (OQ2) — deliberately excludes excludeIds (per-user) so
-- the cache isn't fragmented to a near-zero hit rate.
--
-- Access model: this table has no per-user owner, so the "user owns their
-- row" RLS pattern from profiles/meal_plans doesn't apply here. It must
-- also never be reachable via the browser-shipped anon key — a permissive
-- "any authenticated user can read/write" policy would let any client hit
-- Spoonacular's cached results directly with attacker-controlled params,
-- bypassing the app's own quota discipline. RLS is enabled with zero
-- policies for anon/authenticated (default-deny); only a service-role
-- client (src/lib/supabase/admin.ts), which bypasses RLS and only ever
-- runs in our own server-side orchestration code, can read/write it.

create table if not exists public.recipe_query_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  tolerance_tier text not null check (tolerance_tier in ('p10', 'p20', 'p30')),
  params jsonb not null,
  candidates jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.recipe_query_cache enable row level security;
-- Intentionally no policies — default-deny for anon/authenticated.
