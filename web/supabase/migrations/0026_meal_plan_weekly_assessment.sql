-- Surfaces planCritic.ts's overallAssessment to users (previously computed
-- every generation but only ever console.log'd, orchestrate.ts). Nullable:
-- the critique pass is best-effort and already skips gracefully with no
-- ANTHROPIC_API_KEY or on any API failure (see orchestrate.ts's "Skipped
-- entirely, gracefully" comment) -- an old row generated before this column
-- existed, or a generation where the critique call failed, both have no
-- assessment to show, not an error.
--
-- Reflects the plan's state as assessed DURING generation, before any
-- critic-triggered repair swaps run afterward -- same caveat the existing
-- console.log already carries. A flagged issue that gets repaired may still
-- be mentioned in this text; framed in the UI as generation-time commentary,
-- not a live description of the current plan.

alter table public.meal_plans
  add column if not exists weekly_assessment text;
