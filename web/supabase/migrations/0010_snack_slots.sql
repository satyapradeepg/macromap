-- Epic E2 rework — real snack slots (snack1/snack2), built by composing
-- 2-3 whole-food ingredients (snackComposition.ts) rather than Spoonacular
-- recipe search: live-tested, Spoonacular's type=snack corpus is dominated
-- by low-protein soups/dips/salads and has as few as 8 real matches at
-- Prospre-scale snack macro targets. Three changes to meal_plan_slots,
-- all additive/widening — no data loss for existing rows:
--
-- 1. meal_type's check widened to allow 'snack1'/'snack2' (dynamic drop,
--    same pattern as migration 0009, since 0005's check was unnamed).
-- 2. recipe_id becomes nullable — a composed snack has no single
--    Spoonacular recipe backing it (its component ingredients, each with
--    a real Spoonacular ingredient id, go in the existing `ingredients`
--    jsonb column instead, the same shape recipes already use — so F4's
--    future grocery dedup doesn't need special-casing for snacks).
-- 3. recipe_source's check widened to add 'composed' — distinct from the
--    (not-yet-built) 'ai_composed' value, since this is a deterministic
--    ingredient-composition mechanism, not an LLM judgment call.

do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.meal_plan_slots'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%meal_type%'
  loop
    execute format('alter table public.meal_plan_slots drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.meal_plan_slots
  add constraint meal_plan_slots_meal_type_check
    check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack1', 'snack2'));

alter table public.meal_plan_slots
  alter column recipe_id drop not null;

do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.meal_plan_slots'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%recipe_source%'
  loop
    execute format('alter table public.meal_plan_slots drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.meal_plan_slots
  add constraint meal_plan_slots_recipe_source_check
    check (recipe_source in ('spoonacular', 'ai_composed', 'ai_edited', 'composed'));
