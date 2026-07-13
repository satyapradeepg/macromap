-- Epic E2's F3 budget-aware filtering is gated on Free vs. Pro tier (PRD
-- 7.3, "Tier gates"), but no billing system exists yet. Defaulting every
-- profile to 'free' and allowing manual flips (e.g. via the Supabase
-- dashboard) is the agreed stand-in until real billing is built — that's
-- a separate, later piece of work, not part of E2.

alter table public.profiles
  add column if not exists tier text not null default 'free'
    check (tier in ('free', 'pro'));
