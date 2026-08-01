-- meal_plans was missing an UPDATE policy (0005_meal_plans.sql only granted
-- select/insert). recomputeWeeklyActual (actions.ts) updates weekly_actual_*
-- via the RLS-enforced client after every swap; with RLS enabled and no
-- permissive update policy, Postgres silently matches 0 rows and returns no
-- error, so the weekly summary never reflected a swap. Live-verified before
-- this fix: meal_plans.weekly_actual_* stayed at its pre-swap value while
-- the swapped meal_plan_slots row correctly updated underneath it.

create policy "Users can update their own meal plans"
on public.meal_plans for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
