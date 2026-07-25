-- Follow-up to 0016. A single ingredient id can legitimately need TWO
-- simultaneous rates, not one: aggregate.ts splits a same-id group into
-- separate lines whenever their units disagree (needsManualCombine) --
-- confirmed live, e.g. "1.2l chicken broth" and "1.3 kgs chicken broth"
-- both appear for the same real ingredient. Each needs its own basis
-- ('per_100ml' vs 'per_100g'), so (user, ingredient, region) alone is no
-- longer a valid uniqueness key -- it must include `basis`, or the second
-- rate would collide with/overwrite the first via the existing upsert.
--
-- Dynamic constraint drop (same pattern as migrations 0009/0010, since
-- the original constraint in 0014 was unnamed/auto-generated).

do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.grocery_price_overrides'::regclass
      and contype = 'u'
  loop
    execute format('alter table public.grocery_price_overrides drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.grocery_price_overrides
  add constraint grocery_price_overrides_user_ingredient_region_basis_key
    unique (user_id, spoonacular_ingredient_id, region, basis);
