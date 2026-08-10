-- Epic E2 rework (F5 Pantry Log, moved up from V2 per the pantry-first
-- architecture pivot — see docs/PRD-MacroMap.md 7.3 F5, docs/ai-agents.md
-- Agent 3). MVP scope only: manual entry with rough quantities. 7-day
-- auto-expiry remains V2 and is not modeled here — add as a separate
-- migration if built, matching this repo's existing pattern (e.g.
-- 0002/0003 each scoped to one addition).
--
-- spoonacular_ingredient_id is nullable and resolved lazily via
-- /food/ingredients/search (live-confirmed to work, 1.0pt/call) — needed
-- so F4's grocery-list exclusion can match pantry entries against
-- Spoonacular's canonical ingredient id, the same dedup key F4 already
-- uses (docs/PRD-MacroMap.md 7.3 F4). Not required at entry time since
-- F3's includeIngredients query param takes free-text names, not ids.

create table if not exists public.pantry_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null,
  quantity_text text,
  spoonacular_ingredient_id integer,

  created_at timestamptz not null default now()
);

create index if not exists pantry_items_user_id_idx
  on public.pantry_items (user_id);

alter table public.pantry_items enable row level security;

create policy "Users can read their own pantry items"
on public.pantry_items for select
using (auth.uid() = user_id);

create policy "Users can insert their own pantry items"
on public.pantry_items for insert
with check (auth.uid() = user_id);

create policy "Users can update their own pantry items"
on public.pantry_items for update
using (auth.uid() = user_id);

create policy "Users can delete their own pantry items"
on public.pantry_items for delete
using (auth.uid() = user_id);
