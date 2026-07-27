-- Global, cross-user cache of spoonacular.ts's lookupIngredientMacros
-- (src/lib/mealplan/ingredientMacroCache.ts) -- closes a real gap found in
-- a 2026-07-27 quota-waste audit: every OTHER Spoonacular lookup in this
-- codebase already caches globally (ingredient_identity_matches 0019,
-- ingredient_unit_conversions 0020, recipe_instructions_cache 0022,
-- ingredient_aisle_cache 0023), but this one didn't -- so
-- groundIngredientForAiMeal (orchestrate.ts, backing AI-composed meals'
-- open-ended ingredient list) re-fetched live every time, for every user,
-- even for common names ("chicken breast", "brown rice") Claude proposes
-- repeatedly. "N grams of ingredient X has Y calories/protein/carbs/fat" is
-- a universal fact, not per-user or per-plan -- same reasoning as every
-- other cache table here.
--
-- Access model: same as the tables above -- RLS enabled with zero policies
-- (default-deny for anon/authenticated); only the service-role client
-- (src/lib/supabase/admin.ts) reads/writes it.

create table if not exists public.ingredient_macro_lookup_cache (
  query_name text primary key,
  ingredient_id integer not null,
  name text not null,
  calories_per_100g double precision not null,
  protein_g_per_100g double precision not null,
  carbs_g_per_100g double precision not null,
  fat_g_per_100g double precision not null,
  estimated_cost_cents_per_100g double precision,
  resolved_at timestamptz not null default now()
);

alter table public.ingredient_macro_lookup_cache enable row level security;
-- Intentionally no policies — default-deny for anon/authenticated.
