-- AI-composed dish cooking instructions (2026-07-30, "AI-generated meals
-- should have a similar recipe experience to real Spoonacular meals" --
-- Satya's explicit request). Generated lazily on first view by
-- aiComposedRecipeInstructions.ts, from the dish's ALREADY-fixed,
-- already-safety-checked ingredient list -- purely descriptive text, never
-- a new ingredient/macro decision, so it carries none of the composition
-- pipeline's own grounding/safety risk.
--
-- Per-slot, not a global cache like recipe_instructions_cache (0022): an
-- AI-composed dish's exact ingredient list is unique to the one slot it
-- was composed for, so there's no cross-user/cross-plan reuse value a
-- shared Spoonacular recipe id has. Nullable -- null until first viewed
-- (steps are generated on demand, not at plan-generation time, so a dish
-- nobody ever opens never costs a Claude call).

alter table public.meal_plan_slots
  add column if not exists ai_recipe_instructions jsonb;
