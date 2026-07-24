-- Development-phase convenience only (Satya's explicit request, 2026-07-24):
-- default new profiles to Pro so every account exercises Pro-only
-- features (budget-aware planning, Tavily price estimates, pantry sync,
-- full analytics) without a manual per-user flip via the Supabase
-- dashboard (0004's original stand-in). No real billing exists yet, so
-- there's no revenue impact today.
--
-- MUST be reverted to 'free' before real billing/paying users exist —
-- this is a business-logic decision (who gets Pro features for free),
-- not a bug, but it is real revenue exposure if it ships as-is.

alter table public.profiles
  alter column tier set default 'pro';
