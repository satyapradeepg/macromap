-- F5 pantry log + F4 grocery list — structured, OPTIONAL quantity so the
-- grocery list can subtract what's already on hand instead of the current
-- all-or-nothing exclusion (aggregate.ts's matchesPantryItem drops a
-- whole grocery line on any name/id match, regardless of how much is
-- actually in the pantry vs. how much the week's recipes need).
--
-- Purely additive: `quantity_text` (0007) is untouched and still valid on
-- its own as a free-text note -- these two new columns are an optional
-- structured alternative/supplement, never required. A row with either
-- column null falls back to today's exact hard-exclude behavior in
-- aggregate.ts, never a regression for existing entries.

alter table public.pantry_items
  add column if not exists amount numeric,
  add column if not exists unit text;
