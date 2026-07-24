-- Epic E3 (F4), Pro tier — per-user price overrides for the grocery list
-- (docs/PRD-MacroMap.md 7.3 F4: "Manual price override available per
-- item; corrections are stored per user, keyed by ingredient + region,
-- and reused in future weeks instead of re-querying Tavily for the same
-- item — only re-queried if no stored correction exists or it's older
-- than 30 days"). RLS mirrors pantry_items' pattern (0007).
--
-- spoonacular_ingredient_id is NOT NULL here (unlike pantry_items', which
-- is resolved lazily) — a grocery line always carries a resolved id by
-- the time pricing runs, since aggregate.ts's grouping key IS that id.

create table if not exists public.grocery_price_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  spoonacular_ingredient_id integer not null,
  region text not null,
  price_cents integer not null check (price_cents >= 0),

  updated_at timestamptz not null default now(),

  unique (user_id, spoonacular_ingredient_id, region)
);

create index if not exists grocery_price_overrides_user_id_idx
  on public.grocery_price_overrides (user_id);

alter table public.grocery_price_overrides enable row level security;

create policy "Users can read their own grocery price overrides"
on public.grocery_price_overrides for select
using (auth.uid() = user_id);

create policy "Users can insert their own grocery price overrides"
on public.grocery_price_overrides for insert
with check (auth.uid() = user_id);

create policy "Users can update their own grocery price overrides"
on public.grocery_price_overrides for update
using (auth.uid() = user_id);
