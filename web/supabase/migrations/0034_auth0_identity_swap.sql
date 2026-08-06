-- Auth architecture swap: Supabase Auth (anonymous personas + a dev-only
-- /profiles switcher) -> Auth0 as the sole identity provider, wired in via
-- Supabase's Third-Party Auth feature. auth.uid() only resolves an identity
-- for Supabase's OWN auth.users rows; once Auth0-issued JWTs are the only
-- token this app ever sends, the RLS-relevant identity is the JWT's `sub`
-- claim instead, read via (auth.jwt()->>'sub'). Auth0 subject ids look like
-- "auth0|64f2a1b3c4d5e6f7a8b9c0d1" -- not valid uuids -- so every column
-- that used to hold a Supabase auth.users uuid becomes text.
--
-- None of meal_plans/pantry_items/grocery_price_overrides FK through
-- profiles -- each independently references auth.users(id) on delete
-- cascade (confirmed by reading 0001/0005/0007/0014 directly). Dropping
-- auth.users as the identity source means that cascade goes away for all
-- four; account deletion becomes an explicit app-level action instead
-- (see /account's delete-account flow) that removes rows from all four
-- tables directly. Their own child tables (meal_plan_slots,
-- meal_plan_slot_addons) keep cascading fine via their existing uuid FKs
-- to meal_plans(id)/meal_plan_slots(id), untouched here.
--
-- That explicit delete needs a DELETE policy on every table it touches --
-- profiles/meal_plans/grocery_price_overrides never had one (only
-- pantry_items did, 0007), since nothing before this deleted a row directly
-- through the RLS-enforced client; everything else went through the
-- auth.users cascade. Added below, same auth.jwt()->>'sub' pattern as every
-- other policy here.
--
-- Structured in three full passes (drop ALL policies, then retype ALL
-- columns, then recreate ALL policies) rather than per-table, learned live
-- across two failed attempts: Postgres refuses to retype a column any
-- policy anywhere still references, and meal_plan_slots'/
-- meal_plan_slot_addons' policies reference meal_plans.user_id through a
-- subquery join, not just meal_plans' own 4 policies -- a per-table
-- drop-then-alter-then-recreate ordering still leaves those cross-table
-- references dangling when meal_plans.user_id is retyped.

-- ---------------------------------------------------------------------
-- Pass 1: drop every policy this migration touches
-- ---------------------------------------------------------------------
drop policy if exists "Users can read their own profile" on public.profiles;
drop policy if exists "Users can insert their own profile" on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;
drop policy if exists "Users can delete their own profile" on public.profiles;

drop policy if exists "Users can read their own meal plans" on public.meal_plans;
drop policy if exists "Users can insert their own meal plans" on public.meal_plans;
drop policy if exists "Users can update their own meal plans" on public.meal_plans;
drop policy if exists "Users can delete their own meal plans" on public.meal_plans;

drop policy if exists "Users can read slots of their own meal plans" on public.meal_plan_slots;
drop policy if exists "Users can insert slots of their own meal plans" on public.meal_plan_slots;
drop policy if exists "Users can update slots of their own meal plans" on public.meal_plan_slots;

drop policy if exists "Users can read addons of their own meal plan slots" on public.meal_plan_slot_addons;
drop policy if exists "Users can insert addons of their own meal plan slots" on public.meal_plan_slot_addons;
drop policy if exists "Users can update addons of their own meal plan slots" on public.meal_plan_slot_addons;

drop policy if exists "Users can read their own pantry items" on public.pantry_items;
drop policy if exists "Users can insert their own pantry items" on public.pantry_items;
drop policy if exists "Users can update their own pantry items" on public.pantry_items;
drop policy if exists "Users can delete their own pantry items" on public.pantry_items;

drop policy if exists "Users can read their own grocery price overrides" on public.grocery_price_overrides;
drop policy if exists "Users can insert their own grocery price overrides" on public.grocery_price_overrides;
drop policy if exists "Users can update their own grocery price overrides" on public.grocery_price_overrides;
drop policy if exists "Users can delete their own grocery price overrides" on public.grocery_price_overrides;

-- ---------------------------------------------------------------------
-- Pass 2: retype every column that used to hold a Supabase auth.users uuid
-- ---------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles alter column id type text;

alter table public.meal_plans drop constraint if exists meal_plans_user_id_fkey;
alter table public.meal_plans alter column user_id type text;

alter table public.pantry_items drop constraint if exists pantry_items_user_id_fkey;
alter table public.pantry_items alter column user_id type text;

alter table public.grocery_price_overrides drop constraint if exists grocery_price_overrides_user_id_fkey;
alter table public.grocery_price_overrides alter column user_id type text;

-- ---------------------------------------------------------------------
-- Pass 3: recreate every policy against (auth.jwt() ->> 'sub')
-- ---------------------------------------------------------------------
create policy "Users can read their own profile"
on public.profiles for select
using ((auth.jwt() ->> 'sub') = id);

create policy "Users can insert their own profile"
on public.profiles for insert
with check ((auth.jwt() ->> 'sub') = id);

create policy "Users can update their own profile"
on public.profiles for update
using ((auth.jwt() ->> 'sub') = id);

create policy "Users can delete their own profile"
on public.profiles for delete
using ((auth.jwt() ->> 'sub') = id);

create policy "Users can read their own meal plans"
on public.meal_plans for select
using ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can insert their own meal plans"
on public.meal_plans for insert
with check ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can update their own meal plans"
on public.meal_plans for update
using ((auth.jwt() ->> 'sub') = user_id)
with check ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can delete their own meal plans"
on public.meal_plans for delete
using ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can read slots of their own meal plans"
on public.meal_plan_slots for select
using (
  meal_plan_id in (
    select id from public.meal_plans where user_id = (auth.jwt() ->> 'sub')
  )
);

create policy "Users can insert slots of their own meal plans"
on public.meal_plan_slots for insert
with check (
  meal_plan_id in (
    select id from public.meal_plans where user_id = (auth.jwt() ->> 'sub')
  )
);

create policy "Users can update slots of their own meal plans"
on public.meal_plan_slots for update
using (
  meal_plan_id in (
    select id from public.meal_plans where user_id = (auth.jwt() ->> 'sub')
  )
);

create policy "Users can read addons of their own meal plan slots"
on public.meal_plan_slot_addons for select
using (
  meal_plan_slot_id in (
    select mps.id
    from public.meal_plan_slots mps
    join public.meal_plans mp on mp.id = mps.meal_plan_id
    where mp.user_id = (auth.jwt() ->> 'sub')
  )
);

create policy "Users can insert addons of their own meal plan slots"
on public.meal_plan_slot_addons for insert
with check (
  meal_plan_slot_id in (
    select mps.id
    from public.meal_plan_slots mps
    join public.meal_plans mp on mp.id = mps.meal_plan_id
    where mp.user_id = (auth.jwt() ->> 'sub')
  )
);

create policy "Users can update addons of their own meal plan slots"
on public.meal_plan_slot_addons for update
using (
  meal_plan_slot_id in (
    select mps.id
    from public.meal_plan_slots mps
    join public.meal_plans mp on mp.id = mps.meal_plan_id
    where mp.user_id = (auth.jwt() ->> 'sub')
  )
);

create policy "Users can read their own pantry items"
on public.pantry_items for select
using ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can insert their own pantry items"
on public.pantry_items for insert
with check ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can update their own pantry items"
on public.pantry_items for update
using ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can delete their own pantry items"
on public.pantry_items for delete
using ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can read their own grocery price overrides"
on public.grocery_price_overrides for select
using ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can insert their own grocery price overrides"
on public.grocery_price_overrides for insert
with check ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can update their own grocery price overrides"
on public.grocery_price_overrides for update
using ((auth.jwt() ->> 'sub') = user_id);

create policy "Users can delete their own grocery price overrides"
on public.grocery_price_overrides for delete
using ((auth.jwt() ->> 'sub') = user_id);

-- ---------------------------------------------------------------------
-- test_personas: dev-only picker being removed entirely, per Satya's
-- explicit call (no migration path -- the two rows in there are throwaway
-- test data, not real users). Clean up the underlying anonymous
-- auth.users rows it created (persona-<uuid>@personas.macromap.internal)
-- before dropping the table, so nothing orphaned is left behind.
-- ---------------------------------------------------------------------
delete from auth.users where email like 'persona-%@personas.macromap.internal';
drop table if exists public.test_personas;
