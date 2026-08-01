-- Dev-only test-persona switcher (never reachable in production, gated on
-- TEST_LOGIN_PASSPHRASE being set at all in the running environment).
-- Stores the mapping from a friendly label to the underlying anonymous
-- auth.users identity used for that test persona, plus its refresh token so
-- a Server Action can call auth.refreshSession() to make that identity's
-- session become the active browser session again ("switch").
--
-- No RLS policies defined on purpose (default-deny for anon/authenticated),
-- same convention as recipe_query_cache (0006)/ingredient_identity_matches
-- (0019) -- only the service-role/admin client ever touches this table.
-- persona_user_id is intentionally NOT a foreign key to auth.users: this
-- table must survive a persona's auth.users row being deleted (deletePersona
-- deletes the auth user first, then this row), so a FK with cascade would
-- just be a no-op ordering hazard, not a real integrity guarantee here.

create table if not exists public.test_personas (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,
  persona_user_id uuid not null,
  refresh_token text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

alter table public.test_personas enable row level security;
