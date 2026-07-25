-- Tracks whether a cached conversion rate came from Spoonacular's real
-- density-grounded /recipes/convert endpoint or an AI density estimate
-- (lib/grocery/unitConversion.ts's new fallback for when Spoonacular has no
-- data for an ingredient/unit pair). Same "never silently pass off a guess
-- as verified data" precedent as PlanView.tsx's "AI-composed" slot label --
-- callers that show a converted/combined grocery line to the user need to
-- know which case they're in so an AI-estimated merge can be flagged for a
-- quick double-check instead of looking identical to a real density figure.

alter table public.ingredient_unit_conversions
  add column if not exists source text not null default 'spoonacular'
  check (source in ('spoonacular', 'ai_estimate'));
