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
//
// Spoonacular's /recipes/convert is the PRIMARY source, but it doesn't
// recognize every ingredient (obscure items, typos, multi-word descriptors
// it can't parse) and returns a non-ok response rather than a rate in that
// case -- unlike the "silently assumes water density" risk noted above,
// this failure mode is at least detectable. When it fails, an AI density
// estimate (migration 0021's `source` column) is a strictly better fallback
// than the pre-fix behavior of just giving up and flagging the grocery line
// for manual combining -- same "a guess beats a guaranteed-wrong hard stop"
// reasoning this file already applies to Spoonacular's own water-density
// fallback. Every AI-estimated rate is tagged `source: "ai_estimate"` so
// callers can flag it to the user as worth double-checking, rather than
// letting it look identical to a real density figure.

import { createAdminClient } from "@/lib/supabase/admin";

// Cheap estimation, not deep reasoning -- same standing as
// identityMatch.ts's MODEL constant; confirm against the latest available
// Haiku-tier model at deploy time.
const AI_ESTIMATE_MODEL = "claude-haiku-4-5-20251001";

export type ConversionSource = "spoonacular" | "ai_estimate";

export interface ResolvedConversion {
  rate: number;
  source: ConversionSource;
}

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

const ESTIMATE_CONVERSION_TOOL = {
  name: "estimate_ingredient_conversion",
  description:
    "Estimate how many target units equal one source unit of a grocery ingredient, from its typical density (weight<->volume) or typical per-unit size (a count like 'clove' or 'slice').",
  input_schema: {
    type: "object",
    properties: {
      targetPerSource: {
        type: "number",
        description: "How many `targetUnit` equal one `sourceUnit` of this ingredient. Must be a positive number.",
      },
    },
    required: ["targetPerSource"],
  },
};

function buildEstimatePrompt(ingredientName: string, sourceUnit: string, targetUnit: string): string {
  return `A grocery list needs to combine two quantities of the same ingredient, "${ingredientName}", logged in different units -- one in "${sourceUnit}" and one in "${targetUnit}".

Using your general knowledge of this ingredient's typical density (for weight<->volume conversions) or typical per-unit size (for a count like "clove" or "slice"), estimate: how many ${targetUnit} equal one ${sourceUnit} of ${ingredientName}?

Give your best real-world estimate rather than assuming water-equivalent density or an arbitrary count -- e.g. a cup of flour weighs much less than a cup of water, and a cup of honey weighs more.`;
}

// Never trusts the LLM's JSON shape blindly, same "never fake progress"
// discipline as identityMatch.ts's parseMatchResponse. Exported (pure, no
// network) so it's directly unit-testable rather than the network call
// itself, matching this codebase's existing convention for LLM call sites.
export function parseEstimateResponse(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>).targetPerSource;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

async function estimateConversionRateViaAI(
  ingredientName: string,
  sourceUnit: string,
  targetUnit: string,
): Promise<number | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AI_ESTIMATE_MODEL,
        max_tokens: 256,
        tools: [ESTIMATE_CONVERSION_TOOL],
        tool_choice: { type: "tool", name: "estimate_ingredient_conversion" },
        messages: [{ role: "user", content: buildEstimatePrompt(ingredientName, sourceUnit, targetUnit) }],
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let body: { content?: unknown };
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const toolUse = (Array.isArray(body.content) ? body.content : []).find(
    (block: { type: string }) => block.type === "tool_use",
  ) as { input?: unknown } | undefined;
  if (!toolUse) return null;

  return parseEstimateResponse(toolUse.input);
}

async function upsertRate(
  admin: ReturnType<typeof createAdminClient>,
  ingredientName: string,
  sourceUnit: string,
  targetUnit: string,
  rate: number,
  source: ConversionSource,
): Promise<void> {
  await admin
    .from("ingredient_unit_conversions")
    .upsert(
      { ingredient_name: ingredientName, source_unit: sourceUnit, target_unit: targetUnit, rate, source },
      { onConflict: "ingredient_name,source_unit,target_unit" },
    );
}

async function resolveConversionRateInternal(
  ingredientName: string,
  sourceUnit: string,
  targetUnit: string,
): Promise<ResolvedConversion | null> {
  const name = normalize(ingredientName);
  const source = normalize(sourceUnit);
  const target = normalize(targetUnit);
  if (source === target) return { rate: 1, source: "spoonacular" };

  const admin = createAdminClient();
  const { data: cached } = await admin
    .from("ingredient_unit_conversions")
    .select("rate, source")
    .eq("ingredient_name", name)
    .eq("source_unit", source)
    .eq("target_unit", target)
    .maybeSingle();

  if (cached) return { rate: cached.rate, source: (cached.source as ConversionSource) ?? "spoonacular" };

  const spoonacularRate = await fetchConversionRate(name, source, target);
  if (spoonacularRate !== null) {
    await upsertRate(admin, name, source, target, spoonacularRate, "spoonacular");
    return { rate: spoonacularRate, source: "spoonacular" };
  }

  const aiRate = await estimateConversionRateViaAI(name, source, target);
  if (aiRate !== null) {
    await upsertRate(admin, name, source, target, aiRate, "ai_estimate");
    return { rate: aiRate, source: "ai_estimate" };
  }

  return null;
}

// Resolves "how many `targetUnit` equal one `sourceUnit` of
// `ingredientName`" -- e.g. resolveConversionRate("greek yogurt", "ml",
// "g") answers "how many grams is 1 ml of greek yogurt." Returns null when
// no rate can be determined at all, even via the AI fallback -- the caller
// (aggregate.ts, via a precomputed PantryExclusionItem.unitConversionRates
// map) falls back to the pre-existing safe hard-exclude in that case, never
// a regression. Kept as a plain-number return for this, its original
// caller (pantry crediting, which never surfaces provenance to the user);
// see resolveConversionRateWithSource for callers that need to know
// whether a rate is real density data or an AI guess.
export async function resolveConversionRate(
  ingredientName: string,
  sourceUnit: string,
  targetUnit: string,
): Promise<number | null> {
  const resolved = await resolveConversionRateInternal(ingredientName, sourceUnit, targetUnit);
  return resolved ? resolved.rate : null;
}

// Same resolution (cache -> Spoonacular -> AI estimate), but returns the
// source alongside the rate -- for grocery-line merging (aggregate.ts's
// mergeConvertibleLines), where an AI-estimated conversion should be
// flagged to the user as worth double-checking rather than shown identical
// to a verified Spoonacular density figure.
export async function resolveConversionRateWithSource(
  ingredientName: string,
  sourceUnit: string,
  targetUnit: string,
): Promise<ResolvedConversion | null> {
  return resolveConversionRateInternal(ingredientName, sourceUnit, targetUnit);
}
