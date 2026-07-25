// Grocery-list categorization (grouping by aisle, e.g. "Produce", "Baking")
// — resolved purely at the grocery-list layer, keyed by a grocery line's
// already-resolved ingredientId/name, the same way groceryData.ts's pricing
// already works (resolvePricedLines). Deliberately NOT threaded through the
// meal-plan generation/persistence pipeline (RecipeCandidate/CandidateIngredient/
// meal_plan_slots.ingredients) -- that would touch ~10 interfaces and several
// non-spreading map sites across ranking.ts/orchestrate.ts/actions.ts for a
// purely-display grouping feature. Resolving post-aggregation from
// ingredientId alone (like price) covers every line regardless of whether
// it came from a real recipe or a composed snack/AI meal, since both
// already carry a real Spoonacular ingredient id by the time they're a
// GroceryLine.
//
// Cached GLOBALLY (ingredient_aisle_cache, migration 0023), not per user --
// same reasoning as identityMatch.ts/unitConversion.ts.

import { createAdminClient } from "@/lib/supabase/admin";
import { lookupIngredientAisle, SpoonacularQuotaError, SpoonacularRequestError } from "@/lib/spoonacular";

export type AisleSource = "spoonacular" | "ai_estimate";

// Used by callers (groceryData.ts) when resolveIngredientAisle returns null
// entirely -- no API keys configured at all, the one case nothing can
// resolve. GroceryList.tsx sorts this group last rather than wherever "O"
// falls alphabetically among real aisle names.
export const UNCATEGORIZED_AISLE = "Other";

export interface ResolvedAisle {
  aisle: string;
  source: AisleSource;
}

// Mirrors aggregate.ts's isValidIngredientId/groupingKey exactly -- a
// placeholder id (e.g. -1) is a non-unique stand-in Spoonacular returns
// when it can't identify an ingredient at all, shared by unrelated
// ingredients, so it can't be looked up or cached by id.
function isValidIngredientId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

export function aisleCacheKey(ingredientId: number, name: string): string {
  return isValidIngredientId(ingredientId) ? `id:${ingredientId}` : `name:${name.toLowerCase().trim()}`;
}

const AI_ESTIMATE_MODEL = "claude-haiku-4-5-20251001";

// Seeded from Spoonacular's OWN real `aisle` values, live-observed this
// session (source: "spoonacular" rows in ingredient_aisle_cache) -- not a
// generic grocery-store list invented independently. Giving the AI these
// exact strings to prefer, rather than letting it phrase freely, is what
// fixes the near-duplicate sections found live 2026-07-25 ("Spices" vs the
// real "Spices and Seasonings", "Canned Goods" vs the real "Canned and
// Jarred", "Dairy" vs the real "Milk, Eggs, Other Dairy") -- when an
// AI-resolved ingredient's true category overlaps with a real Spoonacular
// one, it now converges on the SAME label instead of a plausible-sounding
// synonym, so the two sources group together instead of splitting.
// Deliberately NOT exhaustive (this session's one test plan didn't exercise
// every real Spoonacular aisle) and deliberately NOT a hard enum -- an
// ingredient that genuinely doesn't fit any of these should get its own
// accurate label rather than be forced into the nearest wrong bucket.
const KNOWN_SPOONACULAR_AISLES = [
  "Produce",
  "Meat",
  "Seafood",
  "Cheese",
  "Milk, Eggs, Other Dairy",
  "Bakery/Bread",
  "Baking",
  "Pasta and Rice",
  "Canned and Jarred",
  "Spices and Seasonings",
  "Oil, Vinegar, Salad Dressing",
  "Nut butters, Jams, and Honey",
  "Nuts",
  "Tea and Coffee",
  "Beverages",
  "Frozen",
  "Ethnic Foods",
  "Health Foods",
];

const ESTIMATE_AISLE_TOOL = {
  name: "estimate_grocery_aisle",
  description: "Estimate the single best grocery-store aisle/section for a given ingredient.",
  input_schema: {
    type: "object",
    properties: {
      aisle: {
        type: "string",
        description:
          "The single most natural US grocery-store aisle/section name for this ingredient. Strongly prefer one of the given known category names if it reasonably fits; only use a different one if none of them fit.",
      },
    },
    required: ["aisle"],
  },
};

function buildEstimatePrompt(name: string): string {
  return `What is the single best US grocery-store aisle/section for "${name}"?

Known real category names for this store, in case one fits -- use the EXACT same wording (not a paraphrase) whenever one applies:
${KNOWN_SPOONACULAR_AISLES.map((a) => `- ${a}`).join("\n")}

This list isn't exhaustive. If "${name}" genuinely doesn't belong in any of them, answer with a different short, standard grocery-store section name instead -- don't force it into the nearest wrong category.`;
}

// Never trusts the LLM's JSON shape blindly -- same "never fake progress"
// discipline as this codebase's other LLM parsers. Exported (pure, no
// network) so it's directly unit-testable.
export function parseAisleEstimate(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>).aisle;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function estimateAisleViaAI(name: string): Promise<string | null> {
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
        max_tokens: 128,
        tools: [ESTIMATE_AISLE_TOOL],
        tool_choice: { type: "tool", name: "estimate_grocery_aisle" },
        messages: [{ role: "user", content: buildEstimatePrompt(name) }],
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

  return parseAisleEstimate(toolUse.input);
}

// Resolves the aisle for one grocery line's ingredient: cache -> real
// Spoonacular data (for a resolved id) -> an AI estimate by name as the
// fallback (an invalid/placeholder id, or a transient Spoonacular failure)
// -- same "a guess beats no grouping at all" precedent as
// unitConversion.ts's density-estimate fallback. Returns null only when
// every source is unavailable (no API keys at all); callers should default
// to an "Other" bucket in that case.
export async function resolveIngredientAisle(ingredientId: number, name: string): Promise<ResolvedAisle | null> {
  const key = aisleCacheKey(ingredientId, name);
  const admin = createAdminClient();
  const { data: cached } = await admin
    .from("ingredient_aisle_cache")
    .select("aisle, source")
    .eq("cache_key", key)
    .maybeSingle();

  if (cached) return { aisle: cached.aisle, source: cached.source as AisleSource };

  let aisle: string | null = null;
  let source: AisleSource = "spoonacular";

  if (isValidIngredientId(ingredientId)) {
    try {
      aisle = await lookupIngredientAisle(ingredientId);
    } catch (err) {
      if (!(err instanceof SpoonacularQuotaError || err instanceof SpoonacularRequestError)) throw err;
      aisle = null;
    }
  }

  if (!aisle) {
    aisle = await estimateAisleViaAI(name);
    source = "ai_estimate";
  }

  if (!aisle) return null;

  await admin
    .from("ingredient_aisle_cache")
    .upsert({ cache_key: key, aisle, source }, { onConflict: "cache_key" });

  return { aisle, source };
}
