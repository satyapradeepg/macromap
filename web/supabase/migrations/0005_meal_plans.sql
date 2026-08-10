-- Epic E2 (F3 meal plan generation). Two tables:
--
-- meal_plans: one row per generated week. Also serves as the "last
-- successful plan" outage fallback (ai-agents.md Agent 2) — since a failed
-- generation never writes a row, the most recent row for a user IS that
-- cache; no separate table needed. Snapshots target macros at generation
-- time (not a live join to profiles) so an archived plan's reconciliation
-- numbers stay meaningful even if the user edits targets afterward, and so
-- Step 6's "previous week's plan is archived and viewable" (PRD 7.1) holds.
--
-- meal_plan_slots: the 21 claimed recipes for a plan (OQ7 concurrency +
-- claim-resolution). ingredients is persisted here for F4's later grocery
-- dedup (OQ4) — F3 doesn't read it back, just doesn't throw it away.

create table if not exists public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  weekly_target_calories numeric not null,
  weekly_target_protein_g numeric not null,
  weekly_target_carbs_g numeric not null,
  weekly_target_fat_g numeric not null,

  weekly_actual_calories numeric not null,
  weekly_actual_protein_g numeric not null,
  weekly_actual_carbs_g numeric not null,
  weekly_actual_fat_g numeric not null,

  -- Weekly reconciliation outcome (OQ2 extended, ±5% band, capped retry
  -- budget of 3). Never silently implies an exact match it didn't hit.
  reconciliation_status text not null check (
    reconciliation_status in ('within_band', 'outside_band_after_retries')
  ),
  retry_queries_used smallint not null default 0
    check (retry_queries_used between 0 and 3),

  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists meal_plans_user_id_generated_at_idx
  on public.meal_plans (user_id, generated_at desc);

alter table public.meal_plans enable row level security;

create policy "Users can read their own meal plans"
on public.meal_plans for select
using (auth.uid() = user_id);

create policy "Users can insert their own meal plans"
on public.meal_plans for insert
with check (auth.uid() = user_id);

create table if not exists public.meal_plan_slots (
  id uuid primary key default gen_random_uuid(),
  meal_plan_id uuid not null references public.meal_plans (id) on delete cascade,

  day_index smallint not null check (day_index between 0 and 6),
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'dinner')),

  recipe_id integer not null,
  recipe_title text not null,
  image_url text,
  servings numeric not null,

  -- Per-serving macros as returned by Spoonacular — what the meal card
  -- displays (PRD 7.3 F3: "Spoonacular returns macros per serving").
  calories numeric not null,
  protein_g numeric not null,
  carbs_g numeric not null,
  fat_g numeric not null,

  -- Spoonacular's own per-serving cost heuristic (cents), used as the
  -- budget-compliance proxy (Pro tier only) — not a real regional grocery
  -- price. Null for Free tier / when Spoonacular didn't return one.
  price_per_serving_cents integer,

  -- Which macro-tolerance cascade tier (OQ2: ±10/±20/±30) this candidate
  -- was matched at, plus the user-facing label if it landed outside ±10%
  -- or is a budget-fallback pick.
  tolerance_tier text not null check (tolerance_tier in ('p10', 'p20', 'p30')),
  match_label text,

  -- extendedIngredients subset (id + measures.metric) for F4's dedup key
  -- (OQ4) — carried forward from the same Spoonacular call, never re-fetched.
  ingredients jsonb not null default '[]',

  created_at timestamptz not null default now(),

  unique (meal_plan_id, day_index, meal_type)
);

create index if not exists meal_plan_slots_meal_plan_id_idx
  on public.meal_plan_slots (meal_plan_id);

alter table public.meal_plan_slots enable row level security;

create policy "Users can read slots of their own meal plans"
on public.meal_plan_slots for select
using (
  meal_plan_id in (select id from public.meal_plans where user_id = auth.uid())
);

create policy "Users can insert slots of their own meal plans"
on public.meal_plan_slots for insert
with check (
  meal_plan_id in (select id from public.meal_plans where user_id = auth.uid())
);

create policy "Users can update slots of their own meal plans"
on public.meal_plan_slots for update
using (
  meal_plan_id in (select id from public.meal_plans where user_id = auth.uid())
);
