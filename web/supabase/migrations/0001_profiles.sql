-- Epic E1 (Onboarding & Goal Setting) scope only: F1 TDEE onboarding +
-- F2 preferences/constraints. Pantry inventory, meal ratings, and the
-- Agent 2 query/plan caches (see docs/ai-agents.md) are separate migrations
-- for Epic E2 / V2 — not created yet, per PRD-MacroMap.md 7.3.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,

  -- F1 onboarding inputs. Stored in metric regardless of which unit the UI
  -- toggle was set to (PRD 7.1: "app converts to kg/cm immediately").
  weight_kg numeric(5, 2) not null check (weight_kg between 30 and 300),
  height_cm numeric(5, 2) not null check (height_cm between 100 and 250),
  age smallint not null check (age between 13 and 100),
  activity_level text not null check (
    activity_level in ('sedentary', 'lightly_active', 'active', 'very_active')
  ),
  goal text not null check (goal in ('cut', 'bulk', 'maintain')),

  -- F1 computed (Mifflin-St Jeor) daily macro targets, user-overridable.
  daily_calories integer not null,
  daily_protein_g integer not null,
  daily_carbs_g integer not null,
  daily_fat_g integer not null,

  -- F2 preferences & constraints. Allergy/dietary filtering is a safety
  -- feature and is never tier-gated (see docs/product-brief.md 07).
  dietary_style text,
  allergies text[] not null default '{}',
  dislikes text[] not null default '{}',

  -- F2 optional budget + region.
  weekly_budget_usd numeric(7, 2),
  zip_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can read their own profile"
on public.profiles for select
using (auth.uid() = id);

create policy "Users can insert their own profile"
on public.profiles for insert
with check (auth.uid() = id);

create policy "Users can update their own profile"
on public.profiles for update
using (auth.uid() = id);
