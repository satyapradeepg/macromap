// Ingredient-specific unit-conversion rates (density for weight<->volume,
// per-unit weight for "other" counts like cloves) via Spoonacular's real
// `/recipes/convert` endpoint -- a structured, ingredient-aware density
// lookup, not a guess. Backs aggregate.ts's cross-category pantry
// matching: previously, a pantry entry matching a grocery line by name
// but declared in an incompatible unit category (e.g. pantry "500ml
// greek yogurt" vs. a line needing "825g greek yogurt" from a different
// recipe) hard-excluded the line ENTIRELY regardless of amount -- found
// live 2026-07-25, a real risk of under-buying since the pantry entry
// can't actually be verified to cover an unrelated unit type.
//
// Live-confirmed (2026-07-25) this endpoint is genuinely density-grounded
// for common ingredients (500ml olive oil -> 456.5g, implied density
// 0.913 g/ml, matches real olive oil density ~0.91-0.92) -- not just
// always echoing a 1:1 water-equivalent. The one real caveat: for an
// ingredient Spoonacular doesn't recognize, it doesn't error -- it
// silently falls back to treating it as water-density (confirmed live:
// a nonsense ingredient name still returned a clean "500 ml are 500
// grams" answer, indistinguishable in shape from a real one). Accepted
// as a bounded, rare risk: even a wrong conversion here is a milder
// failure mode than the guaranteed-wrong full hard-exclude it replaces.
//
// Cached GLOBALLY (ingredient_unit_conversions, migration 0020), not per
// user -- density doesn't depend on who's asking, same reasoning as
// identityMatch.ts. Rates are cached per (ingredient, source unit, target
// unit) rather than per specific amount, since density conversions are
// linear -- one cached rate covers any quantity.

import { createAdminClient } from "@/lib/supabase/admin";

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

async function fetchConversionRate(
  ingredientName: string,
  sourceUnit: string,
  targetUnit: string,
): Promise<number | null> {
  const apiKey = process.env.SPOONACULAR_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    apiKey,
    ingredientName,
    sourceAmount: "1",
    sourceUnit,
    targetUnit,
  });

  let response: Response;
  try {
    response = await fetch(`https://api.spoonacular.com/recipes/convert?${params.toString()}`);
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let body: { targetAmount?: unknown; type?: unknown };
  try {
    body = await response.json();
  } catch {
    return null;
  }
  // Never trust the response shape blindly -- same "never fake progress"
  // discipline as this codebase's other Spoonacular/LLM call sites.
  if (body.type !== "CONVERSION" || typeof body.targetAmount !== "number" || body.targetAmount <= 0) {
    return null;
  }
  return body.targetAmount;
}

// Resolves "how many `targetUnit` equal one `sourceUnit` of
// `ingredientName`" -- e.g. resolveConversionRate("greek yogurt", "ml",
// "g") answers "how many grams is 1 ml of greek yogurt." Returns null
// when the rate can't be determined (no API key, request failure, or a
// malformed response) -- the caller (aggregate.ts, via a precomputed
// PantryExclusionItem.unitConversionRates map) falls back to the
// pre-existing safe hard-exclude in that case, never a regression.
export async function resolveConversionRate(
  ingredientName: string,
  sourceUnit: string,
  targetUnit: string,
): Promise<number | null> {
  const name = normalize(ingredientName);
  const source = normalize(sourceUnit);
  const target = normalize(targetUnit);
  if (source === target) return 1;

  const admin = createAdminClient();
  const { data: cached } = await admin
    .from("ingredient_unit_conversions")
    .select("rate")
    .eq("ingredient_name", name)
    .eq("source_unit", source)
    .eq("target_unit", target)
    .maybeSingle();

  if (cached) return cached.rate;

  const rate = await fetchConversionRate(name, source, target);
  if (rate === null) return null;

  await admin
    .from("ingredient_unit_conversions")
    .upsert({ ingredient_name: name, source_unit: source, target_unit: target, rate }, { onConflict: "ingredient_name,source_unit,target_unit" });

  return rate;
}
