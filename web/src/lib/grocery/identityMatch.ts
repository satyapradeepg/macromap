// LLM-based ingredient-identity classifier for pantry matching (fixes a
// real bug found live 2026-07-25: pantry "green onions" was wrongly
// matching a bare "onion" grocery line via aggregate.ts's word-boundary
// namesOverlap check). No string heuristic can express that distinction
// correctly -- green onions and onions are genuinely different produce a
// grocery store shelves separately, which needs real-world grocery
// knowledge, not a smarter word rule. Same forced tool-call pattern as
// mealProposer.ts/planCritic.ts, for the same reason: reliable structured
// output instead of parsing free text.
//
// Deliberately per-NAME, not per-id: this app already confirmed live that
// one real ingredient (e.g. garlic) routinely splits into several
// DIFFERENT Spoonacular ingredient ids across one plan's grocery lines --
// resolving a pantry item to a single id would only ever match one of
// those lines. Judging identity by name instead means one decision
// (pantry "garlic" vs. line name "garlic") covers every line sharing that
// name regardless of how many different ids they carry.
//
// Cached GLOBALLY (ingredient_identity_matches, migration 0019), not per
// user -- "is pantry X the same purchasable item as grocery line Y" is a
// universal fact, so the first time any user's pantry item is checked
// against a given line name, every future match against that same pair
// (any user, any plan) is a pure cache hit. Same access model as
// recipe_query_cache (0006): service-role client only, default-deny RLS.

import { createAdminClient } from "@/lib/supabase/admin";

// Cheap/fast classification, not deep reasoning -- deliberately NOT the
// claude-sonnet-5 used by planCritic.ts/mealProposer.ts, since this call
// can run once per pantry item rather than once per plan. Confirm against
// the latest available Haiku-tier model at deploy time, same standing
// note as this codebase's other model constants.
const MODEL = "claude-haiku-4-5-20251001";

function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

const MATCH_INGREDIENT_TOOL = {
  name: "match_ingredient_identity",
  description:
    "Decide which grocery-list ingredient names refer to the SAME purchasable grocery item as a pantry ingredient.",
  input_schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        description:
          "The subset of the candidate names (verbatim) that refer to the same purchasable grocery item as the pantry ingredient -- having it on hand means the user does not need to separately buy that line.",
        items: { type: "string" },
      },
    },
    required: ["matches"],
  },
};

function buildPrompt(pantryName: string, candidates: string[]): string {
  return `A user has "${pantryName}" in their pantry. Which of the following grocery-list ingredient names refer to the SAME purchasable grocery item, such that having the pantry item on hand means they don't need to separately buy it?

Candidates:
${candidates.map((c) => `- ${c}`).join("\n")}

Treat differently-prepared or differently-labeled variants of a genuinely different product as NOT matching -- for example, "green onions" and "onion" are different produce items sold separately, and "chicken broth" is not the same purchase as "chicken breast". Only include a candidate if a grocery store would reasonably shelve it as the same item as the pantry ingredient (matching on the core ingredient; minor descriptor differences like brand, "large", or "organic" are fine). When genuinely unsure, leave it out -- a missed match just leaves one redundant line on the list, which is safer than wrongly excluding something the user still needs to buy.`;
}

// Never trusts the LLM's JSON shape blindly -- same "never fake progress"
// discipline as planCritic.ts's validateCritique. Also never trusts it to
// only echo real candidates verbatim: restricts the result to the actual
// candidate set so a hallucinated/reworded name can't silently produce a
// match against something that was never asked about. Exported (pure, no
// network) so it's directly unit-testable, matching this codebase's
// convention of testing the validator rather than the network call itself
// (see planCritic.test.ts).
export function parseMatchResponse(raw: unknown, candidates: string[]): Set<string> | null {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).matches)) {
    return null;
  }
  const candidateSet = new Set(candidates.map(normalizeName));
  const matches = (raw as { matches: unknown[] }).matches.filter((m): m is string => typeof m === "string");
  return new Set(matches.map(normalizeName).filter((m) => candidateSet.has(m)));
}

async function classifyMatches(pantryName: string, candidates: string[]): Promise<Set<string> | null> {
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
        model: MODEL,
        max_tokens: 1024,
        tools: [MATCH_INGREDIENT_TOOL],
        tool_choice: { type: "tool", name: "match_ingredient_identity" },
        messages: [{ role: "user", content: buildPrompt(pantryName, candidates) }],
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const body = await response.json();
  const toolUse = (body.content ?? []).find((block: { type: string }) => block.type === "tool_use");
  if (!toolUse) return null;

  return parseMatchResponse(toolUse.input, candidates);
}

// Returns the subset of `candidateLineNames` (case/whitespace-insensitive)
// that identity-match `pantryName`, using the global cache first and only
// calling the model for names never checked against this pantry name
// before.
export async function resolveIdentityMatches(
  pantryName: string,
  candidateLineNames: string[],
): Promise<Set<string>> {
  const normalizedPantryName = normalizeName(pantryName);
  const distinctCandidates = [...new Set(candidateLineNames.map(normalizeName))];
  if (distinctCandidates.length === 0) return new Set();

  const admin = createAdminClient();
  const { data: cached } = await admin
    .from("ingredient_identity_matches")
    .select("grocery_line_name, is_match")
    .eq("pantry_name", normalizedPantryName)
    .in("grocery_line_name", distinctCandidates);

  const cachedRows = cached ?? [];
  const resolvedNames = new Set(cachedRows.map((r) => r.grocery_line_name));
  const matches = new Set(cachedRows.filter((r) => r.is_match).map((r) => r.grocery_line_name));
  const uncached = distinctCandidates.filter((c) => !resolvedNames.has(c));

  if (uncached.length > 0) {
    const freshMatches = await classifyMatches(normalizedPantryName, uncached);
    // If the model call failed, `freshMatches` is null -- those names are
    // simply left unresolved this time (not cached as either outcome), so
    // a transient API error doesn't calcify into a permanent wrong answer;
    // the next request just tries again.
    if (freshMatches) {
      await admin.from("ingredient_identity_matches").upsert(
        uncached.map((c) => ({
          pantry_name: normalizedPantryName,
          grocery_line_name: c,
          is_match: freshMatches.has(c),
        })),
        { onConflict: "pantry_name,grocery_line_name" },
      );
      for (const c of uncached) {
        if (freshMatches.has(c)) matches.add(c);
      }
    }
  }

  return matches;
}
