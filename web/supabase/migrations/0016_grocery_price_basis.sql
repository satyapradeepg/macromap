-- Epic E3 (F4) grocery pricing fix (2026-07-24). grocery_price_overrides
-- (0014) originally stored `price_cents` as a flat total for whatever
-- amount a grocery line happened to need at the time -- which silently
-- broke on reuse the moment the same ingredient appeared in a DIFFERENT
-- amount the following week (the same underlying bug as pricing a line
-- flat regardless of quantity, just recurring at the cache layer).
--
-- `basis` disambiguates what `price_cents` now means, so it can be
-- correctly rescaled to any line's actual amount instead of reapplied
-- as-is:
--   'per_100g'  -- cents per 100 grams (weight-unit lines)
--   'per_100ml' -- cents per 100 milliliters (volume-unit lines)
--   'flat'      -- cents per one unit-count (count/package/descriptor
--                  lines -- can, clove, serving, etc. -- multiplied
--                  linearly by the line's amount)
--
-- No existing rows to backfill -- all prior grocery_price_overrides rows
-- were test data, deleted earlier this session.

alter table public.grocery_price_overrides
  add column if not exists basis text not null
    check (basis in ('per_100g', 'per_100ml', 'flat'));
