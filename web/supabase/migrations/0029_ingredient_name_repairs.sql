-- Global cache of long/free-text-shaped ingredient name classifications --
-- see lib/grocery/nameRepair.ts. spoonacular.ts's
-- repairOrRejectIngredientName (2026-07-31) only catches garbling shapes a
-- fixed prefix/suffix/digit-count rule can detect; this covers the
-- residual, free-text-shaped cases that need real judgment instead --
-- live-confirmed real examples: a whole recipe title leaking in ("this
-- healthy cranberry pecan greek yogurt chicken salad is easy") and a
-- personal aside ("herbs - i use 1 sprig of thyme & a bay").
--
-- Whether a given raw name string is a clean ingredient name, has a real
-- ingredient name embedded in it, or is unsalvageable is a universal fact
-- about that exact string, not per-user/per-plan -- same "global judgment
-- cache" reasoning as ingredient_line_identity_matches (0024).
--
-- Access model: same as 0024 -- RLS enabled with zero policies
-- (default-deny for anon/authenticated); only the service-role client
-- (src/lib/supabase/admin.ts) reads/writes it.

create table if not exists public.ingredient_name_repairs (
  raw_name text primary key,
  outcome text not null check (outcome in ('clean', 'repaired', 'reject')),
  repaired_name text,
  decided_at timestamptz not null default now()
);

alter table public.ingredient_name_repairs enable row level security;
-- Intentionally no policies — default-deny for anon/authenticated.
