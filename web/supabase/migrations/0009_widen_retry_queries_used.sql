-- Epic E2 rework — 0005's retry_queries_used check assumed a flat "3
-- actions total" budget from before the F3 snack/add-on gap-closer
-- existed. retryBudget.ts now weights add-on attempts (ADDON_ATTEMPT_COST
-- = 1) cheaper than a full recipe requery/exhaustion retry
-- (RECIPE_ACTION_COST = 3) against a default total of 9 (= 3 recipe
-- requeries' worth of quota) — a real generation can now report up to 9
-- individual attempts (if every one is the cheaper add-on type), not just
-- 3, so the old check would reject a legitimate insert. Widened to match.
--
-- 0005's check was an unnamed inline constraint (Postgres auto-generates
-- its name) — found and dropped dynamically here rather than guessing the
-- generated name, so this doesn't silently no-op if the guess is wrong.

do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.meal_plans'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%retry_queries_used%'
  loop
    execute format('alter table public.meal_plans drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.meal_plans
  add constraint meal_plans_retry_queries_used_check
    check (retry_queries_used between 0 and 9);
