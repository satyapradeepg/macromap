-- Audit round 2 (July 15 2026) found two related issues while investigating
-- a live extreme-profile overshoot bug:
--
-- 1. Mifflin-St Jeor (this app's only TDEE formula) is validated for
--    adults -- its accuracy for a growing adolescent is genuinely
--    questionable, and prescribing a real minor a sub-900-calorie
--    "maintenance" target is a safety/liability concern independent of
--    any engine-precision issue. Satya's decision: raise the minimum
--    supported age from 13 to 18 rather than try to make the formula
--    "work" for minors.
-- 2. Separately, this also narrows (but does not fully close -- see
--    engine-audit-2026-07-15-round2.md finding 3) a structural bug where
--    a very small daily target falls below targets.ts's fixed per-meal
--    calorie floors (3 recipe meals x 250 + 2 snacks x 100 = 950 kcal/day
--    minimum, regardless of the user's real target), guaranteeing the
--    whole week overshoots. A 13-year-old at this app's other extreme
--    inputs (30kg/100cm/sedentary) computed to an 839 kcal/day target,
--    below that floor; the remaining case (a small adult on an aggressive
--    cut) is not addressed by this migration and still needs its own fix.
--
-- Found by column reference (conkey -> pg_attribute), not a text match on
-- the constraint definition, since a simple ilike match on "age" would be
-- fragile if the definition text ever changes shape.

do $$
declare
  con record;
begin
  for con in
    select c.conname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.conrelid = 'public.profiles'::regclass
      and c.contype = 'c'
      and a.attname = 'age'
  loop
    execute format('alter table public.profiles drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_age_check
    check (age between 18 and 100);
