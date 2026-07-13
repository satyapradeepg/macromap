-- F1's Mifflin-St Jeor BMR calculation requires biological sex (its constant
-- is +5 for male vs. -161 for female — a 166 kcal/day difference, not a
-- rounding matter). This field was missing from 0001; added here rather
-- than editing 0001 in place since that migration may already be applied.

alter table public.profiles
  add column if not exists biological_sex text not null default 'female'
    check (biological_sex in ('male', 'female'));

alter table public.profiles
  alter column biological_sex drop default;
