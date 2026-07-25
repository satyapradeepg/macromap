// Epic E3 (F4) — Tavily Search API client for grocery price estimates (PRD
// 7.3 F4, OQ5/tech stack: "Returns estimates only, not real retail
// prices"). Native fetch, no HTTP library — same zero-new-deps convention
// as spoonacular.ts.
//
// Tavily is a general web-search API, not a pricing API: there's no
// structured price field to read. `include_answer: true` asks Tavily to
// synthesize a short natural-language answer from the top search results
// (confirmed via Tavily's own API docs, since this repo had no prior
// Tavily integration to follow) — a well-formed price query reliably gets
// back a sentence containing a dollar amount, which is extracted here with
// a plain regex. No LLM call of our own; the estimate itself already
// implicitly comes from Tavily's search+synthesis, matching the PRD's own
// "estimates only" framing rather than a fabricated precision.

const BASE_URL = "https://api.tavily.com/search";

export class TavilyQuotaError extends Error {}
export class TavilyRequestError extends Error {}

interface TavilySearchResponse {
  answer?: string;
}

// Matches "$3.99", "$ 3.99", "3.99 dollars" is NOT matched (deliberately —
// an unlabeled bare number in a price-search answer is too ambiguous to
// trust as a price; only an explicit "$" is treated as one).
const DOLLAR_AMOUNT_PATTERN = /\$\s?(\d+(?:\.\d{1,2})?)/;

export function extractPriceCents(answer: string): number | null {
  const match = DOLLAR_AMOUNT_PATTERN.exec(answer);
  if (!match) return null;
  const dollars = parseFloat(match[1]);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

export interface IngredientPriceLookup {
  priceCents: number;
}

// Tavily's answer text doesn't reliably state a parseable, consistent unit
// basis on its own ("$4.17 per pound" one time, "$13.45 for 2.5-5.25lbs"
// another) — rather than parsing whatever unit Tavily happens to mention,
// `referenceUnit` asks the question in a unit WE choose, so the only thing
// that still needs extracting is the dollar figure itself (unchanged, via
// extractPriceCents).
//
// Two forms:
// - "weight_volume": weight/volume lines, phrased as "per 100g"/"per
//   100ml" — the reference amount is a plain number we pick.
// - "unit_label": count/package/descriptor lines (can, clove, serving,
//   medium...). Found live (2026-07-24): omitting a reference here and
//   asking a generic "average price for X" question, then multiplying
//   that by the line's count, badly overcounts for units like "servings"
//   — Tavily's generic answer is a whole-package price ("$8.96 for a
//   parmesan block"), and multiplying a package price by "6 servings"
//   is not the same number as 6 servings' worth of cheese. Explicitly
//   asking "price per {label}" (e.g. "per serving", "per can", "per
//   clove") gets an answer already scoped to the unit we're about to
//   multiply by, instead of an ambiguous package price.
export type ReferenceQuantity =
  | { type: "weight_volume"; amount: number; unit: "g" | "ml" }
  | { type: "unit_label"; label: string };

function buildQuery(ingredientName: string, region: string, referenceUnit?: ReferenceQuantity): string {
  if (!referenceUnit) {
    return `average US grocery store price for ${ingredientName} in ${region}`;
  }
  if (referenceUnit.type === "weight_volume") {
    return `price of ${ingredientName} per ${referenceUnit.amount}${referenceUnit.unit} in ${region}`;
  }
  return `average US grocery store price per ${referenceUnit.label} of ${ingredientName} in ${region}`;
}

// Returns null for a genuine no-result (no dollar amount in Tavily's
// answer) — maps to the PRD's "$— Price unavailable — add manually" case.
// Throws only on a real request failure; a 429 is modeled as
// TavilyQuotaError, mirroring spoonacular.ts's 402/429 handling, so
// callers can apply the same "don't retry immediately" treatment.
export async function lookupIngredientPrice(
  ingredientName: string,
  region: string,
  referenceUnit?: ReferenceQuantity,
): Promise<IngredientPriceLookup | null> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new TavilyRequestError("TAVILY_API_KEY is not set");
  }

  let response: Response;
  try {
    response = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: buildQuery(ingredientName, region, referenceUnit),
        include_answer: true,
        max_results: 3,
      }),
    });
  } catch (err) {
    throw new TavilyRequestError(`Tavily request failed: ${(err as Error).message}`);
  }

  if (response.status === 429) {
    throw new TavilyQuotaError(`Tavily quota exceeded (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new TavilyRequestError(`Tavily request failed (HTTP ${response.status})`);
  }

  let body: TavilySearchResponse;
  try {
    body = await response.json();
  } catch (err) {
    throw new TavilyRequestError(`Tavily response was not valid JSON: ${(err as Error).message}`);
  }

  if (!body.answer) return null;
  const priceCents = extractPriceCents(body.answer);
  return priceCents === null ? null : { priceCents };
}
