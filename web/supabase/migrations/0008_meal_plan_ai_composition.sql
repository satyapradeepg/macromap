-- Epic E2 rework: AI composition/edit fallback + snack/add-on gap-closer
-- (see docs/PRD-MacroMap.md 7.3 F3 "AI composition/edit fallback" and
-- "Snack/add-on gap-closer", docs/hypotheses.md H8). Additive only —
-- does not touch meal_plan_slots' existing columns or its
-- unique (meal_plan_id, day_index, meal_type) constraint, so the
-- existing deterministic cascade/ranking/reconciliation path (0005) is
-- untouched and this ships alongside it, not instead of it.
--
-- recipe_source and the addon table are deliberately separate, not one
-- combined tag: hypotheses.md's H8 lists spoonacular/ai-composed/
-- ai-edited/snack-addon as four tags, but a snack add-on can attach to
-- ANY slot regardless of its base recipe's source (F3: it's the
-- reconciliation gap-closer, tried before further cascade widening —
-- not exclusive to AI-composed meals). Modeling them as orthogonal
-- dimensions (recipe_source column + optional addon row) avoids losing
-- that a plain Spoonacular meal can also carry an add-on. H8's reporting
-- query can derive its four flat tags from this at read time.

alter table public.meal_plan_slots
  add column if not exists recipe_source text not null default 'spoonacular'
    check (recipe_source in ('spoonacular', 'ai_composed', 'ai_edited'));

-- One optional add-on per slot (F3: "capped at one add-on per slot"),
-- enforced here via the unique FK rather than in application code.
-- Macros are never LLM-estimated (F3's grounding rule) — every add-on
-- resolves through Spoonacular's ingredient endpoint
-- (/food/ingredients/search + /food/ingredients/{id}/information,
-- live-confirmed 1.0pt/call each), same as the composition fallback.
create table if not exists public.meal_plan_slot_addons (
  id uuid primary key default gen_random_uuid(),
  meal_plan_slot_id uuid not null unique
    references public.meal_plan_slots (id) on delete cascade,

  ingredient_name text not null,
  spoonacular_ingredient_id integer not null,
  amount numeric not null,
  unit text not null,

  calories numeric not null,
  protein_g numeric not null,
  carbs_g numeric not null,
  fat_g numeric not null,

  created_at timestamptz not null default now()
);

alter table public.meal_plan_slot_addons enable row level security;

create policy "Users can read addons of their own meal plan slots"
on public.meal_plan_slot_addons for select
using (
  meal_plan_slot_id in (
    select mps.id
    from public.meal_plan_slots mps
    join public.meal_plans mp on mp.id = mps.meal_plan_id
    where mp.user_id = auth.uid()
  )
);

create policy "Users can insert addons of their own meal plan slots"
on public.meal_plan_slot_addons for insert
with check (
  meal_plan_slot_id in (
    select mps.id
    from public.meal_plan_slots mps
    join public.meal_plans mp on mp.id = mps.meal_plan_id
    where mp.user_id = auth.uid()
  )
);

-- Reconciliation retries (F3) can replace an existing add-on in place
-- when nudging toward the weekly deficit, mirroring meal_plan_slots'
-- own update policy (0005) used for the same retry flow.
create policy "Users can update addons of their own meal plan slots"
on public.meal_plan_slot_addons for update
using (
  meal_plan_slot_id in (
    select mps.id
    from public.meal_plan_slots mps
    join public.meal_plans mp on mp.id = mps.meal_plan_id
    where mp.user_id = auth.uid()
  )
);
