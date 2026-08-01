// AI-based fallback for garbled ingredient names that spoonacular.ts's
// repairOrRejectIngredientName can't catch -- that function only handles
// shapes a fixed prefix/suffix/digit-count rule can detect (a bare
// connector word, a leading fragment, 2+ embedded quantities). The
// residual gap is FREE-TEXT-shaped leaks with no fixed pattern at all --
// live-confirmed real examples: a whole recipe title ("this healthy
// cranberry pecan greek yogurt chicken salad is easy") and a personal
// aside ("herbs - i use 1 sprig of thyme & a bay"). Telling these apart
// from a normal (if verbose) ingredient name needs actual judgment, not a
// regex.
//
// Deliberately NOT run on every ingredient -- needsAiCheck's word-count
// trigger is a cheap, high-recall filter (a real single-ingredient name,
// even a verbose real Spoonacular one like "chicken breast halves boned
// and skinned" -- 6 words -- is essentially never this long) so the LLM
// call only fires for the rare long-tail case, and only at grocery-list
// READ time (groceryData.ts), not at Spoonacular ingest -- ingest runs
// over every candidate recipe fetched during generation (most discarded),
// while read time only ever processes a plan's ~35 already-selected
// slots' worth of ingredients.
//
// Threshold lowered from 8 to 7 on 2026-08-01: live end-to-end testing of
// the deployed app found a real 7-word garbled leak ("sundried tomato &
// artichoke tuna casserole: serves", a recipe title + serving-size label
// fragment) that fell one word short of the original threshold and
// reached a real user's grocery list untouched. 7 still sits one full
// word above the longest known genuine ingredient name (6 words, cited
// above), preserving the same safety margin the original threshold was
// set with, just recalibrated against a second real data point.
//
// Cached GLOBALLY (ingredient_name_repairs, migration 0029), not per user
// -- whether a given raw string is a clean name, has a real name
// embedded, or is unsalvageable is a fact about that exact string, same
// "global judgment cache" reasoning as lineIdentity.ts.

import { createAdminClient } from "@/lib/supabase/admin";

// Same tier/reasoning as this codebase's other single-judgment LLM call
// sites (unitConversion.ts's AI_ESTIMATE_MODEL, lineIdentity.ts's MODEL).
const MODEL = "claude-haiku-4-5-20251001";

const AI_CHECK_WORD_THRESHOLD = 7;

// Pure, no network -- exported for direct unit testing. A real single
// ingredient name (even a long, verbose real Spoonacular descriptor) is
// essentially never this long; live-confirmed offenders are 7-11+ words.
export function needsAiNameCheck(name: string): boolean {
  return name.trim().split(/\s+/).filter(Boolean).length >= AI_CHECK_WORD_THRESHOLD;
}

export type NameRepairOutcome = "clean" | "repaired" | "reject";

export interface NameRepairResult {
  outcome: NameRepairOutcome;
  repairedName: string | null;
}

const CLASSIFY_NAME_TOOL = {
  name: "classify_ingredient_name",
  description:
    "Decide whether a raw ingredient-list string is a clean grocery ingredient name, has a real ingredient name embedded in leaked extra text, or has no real ingredient identifiable at all.",
  input_schema: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: ["clean", "repaired", "reject"],
        description:
          "'clean' if this is already a normal purchasable ingredient name (even if long/descriptive). 'repaired' if extra text leaked in but a real ingredient name is clearly identifiable within it. 'reject' if no real, single purchasable ingredient is identifiable at all.",
      },
      repairedName: {
        type: "string",
        description:
          "Only when outcome is 'repaired': the real ingredient name, using the exact words from the input -- never invented or rephrased.",
      },
    },
    required: ["outcome"],
  },
};

function buildPrompt(rawName: string): string {
  return `A recipe's ingredient list has an entry with this exact text: "${rawName}"

Recipe-parsing software sometimes leaks extra text into this field -- a cooking instruction, a personal note or aside, or an entire recipe/dish title -- instead of a clean, short ingredient name like "chicken breast" or "garlic cloves".

Decide one of three outcomes:
- "clean": this is already a normal, purchasable ingredient name (even if a bit long or descriptive) -- leave it as-is.
- "repaired": there's leaked extra text, but a real, specific ingredient name is clearly identifiable within it -- extract JUST that ingredient name, using the exact words from the input, never invented or rephrased.
- "reject": there's no real, single purchasable ingredient identifiable in this text at all (e.g. it's a recipe title, a general comment, or a vague reference with nothing concrete to buy).

When genuinely unsure between "repaired" and "reject", prefer "reject" -- losing one ingredient's quantity from a grocery list is safer than inventing or guessing a wrong one.`;
}

// Never trusts the LLM's JSON shape blindly -- same "never fake progress"
// discipline as this codebase's other LLM call sites (lineIdentity.ts's
// parseLineMatchResponse, unitConversion.ts's parseEstimateResponse).
// Exported (pure, no network) for direct unit testing.
export function parseNameRepairResponse(raw: unknown): NameRepairResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const outcome = (raw as Record<string, unknown>).outcome;
  if (outcome !== "clean" && outcome !== "repaired" && outcome !== "reject") return null;

  if (outcome === "repaired") {
    const repairedName = (raw as Record<string, unknown>).repairedName;
    if (typeof repairedName !== "string" || !repairedName.trim()) return null;
    return { outcome, repairedName: repairedName.trim() };
  }
  return { outcome, repairedName: null };
}

async function classifyNameViaAI(rawName: string): Promise<NameRepairResult | null> {
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
        max_tokens: 512,
        tools: [CLASSIFY_NAME_TOOL],
        tool_choice: { type: "tool", name: "classify_ingredient_name" },
        messages: [{ role: "user", content: buildPrompt(rawName) }],
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

  return parseNameRepairResponse(toolUse.input);
}

// Resolves a long/suspicious raw ingredient name to its final display name
// (cache first, LLM for the rest), or null if it should be dropped
// entirely. A transient failure (no API key, network error, malformed
// response) fails OPEN -- returns the name unchanged rather than dropping
// real grocery data over an infrastructure hiccup, and is never cached, so
// a later call gets a fresh chance (same "never calcify a wrong answer
// from an API error" precedent as this codebase's other LLM call sites).
export async function resolveIngredientName(rawName: string): Promise<string | null> {
  const admin = createAdminClient();

  const { data: cached } = await admin
    .from("ingredient_name_repairs")
    .select("outcome, repaired_name")
    .eq("raw_name", rawName)
    .maybeSingle();

  if (cached) {
    if (cached.outcome === "reject") return null;
    if (cached.outcome === "repaired") return cached.repaired_name;
    return rawName;
  }

  const classified = await classifyNameViaAI(rawName);
  if (!classified) return rawName;

  await admin
    .from("ingredient_name_repairs")
    .upsert({ raw_name: rawName, outcome: classified.outcome, repaired_name: classified.repairedName }, { onConflict: "raw_name" });

  if (classified.outcome === "reject") return null;
  if (classified.outcome === "repaired") return classified.repairedName;
  return rawName;
}
