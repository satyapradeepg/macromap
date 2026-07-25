-- Global, cross-user cache of ingredient-specific unit-conversion rates
-- (density for weight<->volume, per-unit weight for "other" counts like
-- cloves), used by lib/grocery/unitConversion.ts to back aggregate.ts's
-- cross-category pantry matching. "How many grams equal 1 ml of greek
-- yogurt" is a universal physical fact, not per-user or per-region --
-- same reasoning as ingredient_identity_matches (0019): the first time
-- any user's pantry item needs a given (ingredient, source unit, target
-- unit) conversion, every future need for that same triple (any user,
-- any plan) is a pure cache hit.
--
-- Access model: same "no per-user owner" pattern as recipe_query_cache
-- (0006) and ingredient_identity_matches (0019) -- RLS enabled with zero
-- policies (default-deny for anon/authenticated); only the service-role
-- client (src/lib/supabase/admin.ts) can read/write it.

create table if not exists public.ingredient_unit_conversions (
  ingredient_name text not null,
  source_unit text not null,
  target_unit text not null,
  rate double precision not null check (rate > 0),
  resolved_at timestamptz not null default now(),
  primary key (ingredient_name, source_unit, target_unit)
);

alter table public.ingredient_unit_conversions enable row level security;
-- Intentionally no policies — default-deny for anon/authenticated.
