-- 0001 modeled dietary_style as a single text value, but F2's presets
-- (vegetarian/vegan/gluten-free/dairy-free/halal/kosher) aren't mutually
-- exclusive in practice (e.g. vegan + gluten-free). allergies and dislikes
-- were already text[]; dietary_style should follow the same pattern.

alter table public.profiles rename column dietary_style to dietary_styles;

alter table public.profiles
  alter column dietary_styles type text[] using
    case when dietary_styles is null then '{}'::text[] else array[dietary_styles] end,
  alter column dietary_styles set default '{}',
  alter column dietary_styles set not null;
