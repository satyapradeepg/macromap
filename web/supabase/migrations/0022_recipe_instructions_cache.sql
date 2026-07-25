-- Global, cross-user cache of a Spoonacular recipe's cooking steps + source
-- link (src/lib/mealplan/recipeInstructions.ts), backing the "View recipe"
-- detail shown on a meal-plan card. "What are the steps for recipe id N" is
-- a universal fact, not per-user or per-plan -- same reasoning as
-- ingredient_identity_matches (0019) and ingredient_unit_conversions (0020):
-- the first time any user opens a given recipe's detail, every future open
-- of that same recipe (any user, any plan) is a pure cache hit, so a
-- recipe that keeps getting reused across many users' plans only ever
-- costs one real Spoonacular call.
--
-- Access model: same "no per-user owner" pattern as those tables -- RLS
-- enabled with zero policies (default-deny for anon/authenticated); only
-- the service-role client (src/lib/supabase/admin.ts) can read/write it.

create table if not exists public.recipe_instructions_cache (
  recipe_id integer primary key,
  steps jsonb not null,
  source_url text,
  fetched_at timestamptz not null default now()
);

alter table public.recipe_instructions_cache enable row level security;
-- Intentionally no policies — default-deny for anon/authenticated.
