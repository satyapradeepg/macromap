-- Global, cross-user cache of ingredient-identity judgments used by
-- lib/grocery/identityMatch.ts, which backs aggregate.ts's pantry
-- matching (PantryExclusionItem.matchedLineNames). Whether a pantry
-- item's name refers to the same purchasable grocery item as a given
-- grocery-line name is a universal fact, not per-user or per-region --
-- unlike grocery_price_overrides (0014), which is legitimately per-user
-- (prices vary by person/region). Once any user's pantry item is checked
-- against a given line name, every future match against that same pair
-- (any user, any plan) is a pure cache hit.
--
-- Access model: same "no per-user owner" pattern as recipe_query_cache
-- (0006) -- RLS enabled with zero policies (default-deny for
-- anon/authenticated); only the service-role client
-- (src/lib/supabase/admin.ts), which bypasses RLS and only ever runs in
-- our own server-side code, can read/write it.

create table if not exists public.ingredient_identity_matches (
  pantry_name text not null,
  grocery_line_name text not null,
  is_match boolean not null,
  decided_at timestamptz not null default now(),
  primary key (pantry_name, grocery_line_name)
);

alter table public.ingredient_identity_matches enable row level security;
-- Intentionally no policies — default-deny for anon/authenticated.
