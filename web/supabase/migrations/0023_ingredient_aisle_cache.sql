-- Global, cross-user cache of which grocery-store aisle/category an
-- ingredient belongs to (src/lib/grocery/ingredientAisle.ts), backing the
-- grocery list's grouped-by-aisle display. "What aisle is ingredient X in"
-- is a universal fact, not per-user or per-plan -- same reasoning as every
-- other global cache this session (ingredient_identity_matches 0019,
-- ingredient_unit_conversions 0020, recipe_instructions_cache 0022): the
-- first time any user's grocery line needs a given ingredient's aisle,
-- every future need for that same ingredient (any user, any plan) is a
-- pure cache hit.
--
-- cache_key mirrors lib/grocery/aggregate.ts's groupingKey convention
-- exactly ('id:<n>' for a resolved Spoonacular ingredient id, 'name:<...>'
-- for a placeholder/unresolved id like -1) -- a placeholder id is a
-- non-unique stand-in shared by unrelated ingredients Spoonacular couldn't
-- identify, so keying by id alone there would wrongly conflate them; the
-- name-keyed fallback (AI-estimated, see `source`) avoids that.
--
-- Access model: same "no per-user owner" pattern as the caches above --
-- RLS enabled with zero policies (default-deny for anon/authenticated);
-- only the service-role client (src/lib/supabase/admin.ts) can read/write it.

create table if not exists public.ingredient_aisle_cache (
  cache_key text primary key,
  aisle text not null,
  source text not null default 'spoonacular' check (source in ('spoonacular', 'ai_estimate')),
  resolved_at timestamptz not null default now()
);

alter table public.ingredient_aisle_cache enable row level security;
-- Intentionally no policies — default-deny for anon/authenticated.
