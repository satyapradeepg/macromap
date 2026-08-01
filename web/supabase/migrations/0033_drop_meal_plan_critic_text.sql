-- Removes the two display-only critic text columns added in 0026/0027.
-- weekly_assessment (planCritic.ts's overallAssessment) proved unreliable
-- live 2026-08-01: it described a macro comparison that was factually
-- backwards against the plan's own real data, and a diet-violation claim
-- with no corresponding ingredient anywhere in the plan -- and even when
-- accurate, it's captured BEFORE the same-call repair pass runs, so it can
-- describe a problem already fixed by the time a user reads it. The
-- underlying critique call and its flaggedSlots-driven repair mechanism
-- (planCritic.ts/planRepair.ts) are unaffected and keep running -- only
-- this free-text summary, which had no consumer besides this display, is
-- being dropped. grocery_notes (groceryCritic.ts) is removed alongside it
-- since that entire check was display-only with no other consumer, and the
-- feature itself is being retired.

alter table public.meal_plans
  drop column if exists weekly_assessment,
  drop column if exists grocery_notes;
