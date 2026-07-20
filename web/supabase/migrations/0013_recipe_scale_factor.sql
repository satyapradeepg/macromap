-- Recipe portion scaling (July 20 2026 spec, day3/recipe-portion-scaling-
-- spec-2026-07-20.md). ranking.ts's rankCandidates now scales a recipe
-- candidate's serving size to better fit its slot's macro target — every
-- macro/price/servings column below already stores the SCALED value (see
-- 0005's column comment: "what the meal card displays"), so this column
-- exists only to record what scale was applied, for display/debugging.
-- Additive only, default 1 (unscaled) for every existing row.

alter table public.meal_plan_slots
  add column if not exists scale_factor numeric not null default 1;
