-- Grocery-list sanity-check pass (2026-07-27, groceryCritic.ts). Nullable
-- and best-effort, same shape as 0026's weekly_assessment: computed once at
-- generation time over the plan's OWN aggregated ingredient list (before
-- pantry/pricing/aisle resolution), non-null only when a real concern was
-- found (an implausible quantity, or an obvious same-product duplicate) --
-- most plans will leave this null, which is the expected common case, not
-- a missing/failed check. Also null on any plan generated before this
-- column existed, or wherever the check itself was skipped/failed (no
-- ANTHROPIC_API_KEY, or any API error).

alter table public.meal_plans
  add column if not exists grocery_notes text;
