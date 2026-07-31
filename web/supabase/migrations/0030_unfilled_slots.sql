-- Persona audit 2026-07-31, finding #3 (Phase 4): a recipe-mechanism slot
-- that fails EVERY fallback (real-recipe cascade, all AI-compose attempts,
-- and pass 4's relaxed-bounds closest-real-recipe last resort) today has
-- NO meal_plan_slots row at all -- it only ever existed as an ephemeral
-- blockedSlots array on the action's return value (see data.ts's
-- getMostRecentPlan, which always returns blockedSlots: [] since a
-- reloaded plan has no way to recover which slots were blocked or why).
-- This should now be a rare tail case (pass 4 closes the overwhelming
-- majority of real gaps), but a probabilistic pipeline can never guarantee
-- zero -- widen recipe_source so the rare residual case gets a real,
-- visible, honest placeholder row instead of silently vanishing on the
-- next page load. Additive/widening only, same pattern as migration 0010.

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
    check (recipe_source in ('spoonacular', 'ai_composed', 'ai_edited', 'composed', 'unfilled'));
