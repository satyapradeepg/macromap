-- 0009 widened retry_queries_used to 0-9, sized for a SINGLE retry budget's
-- worth of attempts (9 units / cheapest ADDON_ATTEMPT_COST=1 = 9 max
-- attempts). That was correct when reconciliation was a single weekly
-- pass, but orchestrate.ts has run reconciliation PER DAY (a fresh 9-unit
-- budget each of the 7 days, see retryBudget.ts) since before 0009 was
-- written — 0009 widened the constraint without re-deriving it against the
-- per-day model already in place, so it stayed sized for one day instead
-- of seven.
--
-- Found live July 15 2026: fixing a separate quota-exhaustion bug (an
-- uncached ingredient lookup that used to burn through Spoonacular's daily
-- quota and abort generation early) let a real generation run to
-- completion for the first time on a scarce-corpus profile and report
-- retryQueriesUsed=31 — comfortably over the old 0-9 cap, which the insert
-- had simply never reached before because quota exhaustion always crashed
-- the request first.
--
-- True worst case given today's constants: exhaustion budget maxes at 3
-- attempts (9 units / RECIPE_ACTION_COST=3), and each of the 7 days'
-- independent budgets maxes at 9 attempts (9 units / ADDON_ATTEMPT_COST=1)
-- -> 3 + (9 * 7) = 66.
--
-- Same dynamic-drop pattern as 0009 (the constraint's generated name
-- shouldn't be guessed).

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
    check (retry_queries_used between 0 and 66);
