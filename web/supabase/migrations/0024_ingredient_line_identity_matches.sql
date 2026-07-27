-- Global, cross-user cache of ingredient-identity judgments used by
-- lib/grocery/lineIdentity.ts, the DISPLAY-side counterpart to
-- ingredient_identity_matches (0019). That table confirms pantry-name vs.
-- grocery-line-name identity (fixes pantry subtraction only); this one
-- confirms identity BETWEEN TWO grocery-line names, so lines that resolve
-- to different Spoonacular ingredient ids for the SAME real ingredient
-- (live-confirmed 2026-07-25: one plan's "onion" split across ids 11282,
-- 10011282, 10511282) can be shown as one combined line instead of
-- several. See aggregate.ts's PantryPool comment and identityMatch.ts's
-- header for the original pantry-side version of this same problem.
--
-- Whether two grocery-list ingredient names refer to the same purchasable
-- item is a universal fact, not per-user/per-plan -- same reasoning as
-- 0019. name_a/name_b are always stored with name_a < name_b
-- (lexicographic, enforced by the calling code, not a DB constraint) so an
-- unordered pair is cached exactly once regardless of which name was
-- queried as the "anchor".
--
-- Access model: same as 0019 -- RLS enabled with zero policies
-- (default-deny for anon/authenticated); only the service-role client
-- (src/lib/supabase/admin.ts) reads/writes it.

create table if not exists public.ingredient_line_identity_matches (
  name_a text not null,
  name_b text not null,
  is_match boolean not null,
  decided_at timestamptz not null default now(),
  primary key (name_a, name_b)
);

alter table public.ingredient_line_identity_matches enable row level security;
-- Intentionally no policies — default-deny for anon/authenticated.
