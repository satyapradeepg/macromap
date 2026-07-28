// Epic E3 (F4) follow-up (2026-07-27) — a one-shot Claude sanity-check over
// a plan's aggregated grocery list, same shape and placement rationale as
// mealplan/planCritic.ts: the deterministic aggregation pipeline
// (aggregate.ts's buildGroceryLines/mergeConvertibleLines) never holds the
// WHOLE list in view at once the way a human skimming it would, so it
// structurally can't notice "wait, that's clearly the same ingredient under
// two different names" or "500 cloves of garlic is obviously a units bug" —
// that requires the same kind of holistic, cross-line judgment call
// planCritic.ts already established as this project's bar for introducing
// an LLM (see that file's header comment).
//
// Deliberately NOT a per-line/per-view check: called exactly once, at
// generation time (actions.ts's generatePlan), over the plan's OWN
// ingredient output, before pantry/pricing/aisle resolution ever runs —
// pantry contents and pricing change independently of the plan and don't
// need a fresh critique on every view (same "computed at generation time,
// not live" tradeoff planCritic.ts's own weeklyAssessment already makes,
// see orchestrate.ts). Running this per-view (the grocery list's actual
// hot path, re-fetched on every pantry change/page load) would be exactly
// the "expensive, frequent" trap this codebase has repeatedly killed
// elsewhere (see spoonacular.ts's CANDIDATES_PER_QUERY / tryAttachAddon
// discipline) -- once per plan is the only place this is cheap enough to
// justify.
const MODEL = "claude-sonnet-5";

export interface GroceryLineSummary {
  name: string;
  totalAmount: number;
  unit: string;
  // aggregate.ts's GroceryLine.needsManualCombine — already-known
  // "couldn't reconcile automatically" lines are the most likely place a
  // real duplicate-product miss would show up, worth calling out
  // specifically in the prompt below.
  needsManualCombine: boolean;
}

const CHECK_GROCERY_LIST_TOOL = {
  name: "check_grocery_list",
  description: "Flag a real, concrete problem in a generated grocery list — not general commentary.",
  input_schema: {
    type: "object",
    properties: {
      hasConcerns: {
        type: "boolean",
        description: "true only if something genuinely looks wrong -- an implausible quantity, or two lines that are clearly the same product under different names. false for an ordinary, unremarkable list.",
      },
      note: {
        type: "string",
        description: "1-2 sentences naming the SPECIFIC line(s) and why -- empty string when hasConcerns is false.",
      },
    },
    required: ["hasConcerns", "note"],
  },
};

function buildPrompt(lines: GroceryLineSummary[]): string {
  const rows = lines
    .map((l) => `${l.totalAmount} ${l.unit} ${l.name}${l.needsManualCombine ? " (flagged: couldn't auto-combine with a sibling line for this ingredient)" : ""}`)
    .join("\n");

  return `Review this generated grocery list for real, concrete errors only -- not style or organization preferences.

${rows}

Look specifically for:
1. An implausible quantity for a real ingredient (e.g. hundreds of a whole item, or an amount clearly off by a unit-conversion error).
2. Two or more lines that are obviously the same product under different names, spellings, or brand qualifiers that should have merged into one line.

Don't flag ordinary list untidiness (many small spice lines, a wide variety of items) -- only flag something a shopper would actually notice as wrong. If nothing looks genuinely off, set hasConcerns to false and leave note empty.`;
}

// Never trusts the LLM's JSON shape blindly, same discipline as
// planCritic.ts's validateCritique -- malformed output is treated as "no
// concerns to report," never a crash.
export function validateGroceryCheck(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.hasConcerns !== "boolean") return null;
  if (typeof obj.note !== "string") return null;
  if (!obj.hasConcerns) return null;
  return obj.note || null;
}

// Returns null (never throws) on a missing API key, a failed request, or a
// malformed/no-concerns response -- a skipped or empty result here must
// never block or alter the real, already-complete plan/grocery-list
// generation it runs alongside, same as planCritic.ts's critiquePlan.
export async function checkGroceryList(lines: GroceryLineSummary[]): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (lines.length === 0) return null;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        tools: [CHECK_GROCERY_LIST_TOOL],
        tool_choice: { type: "tool", name: "check_grocery_list" },
        messages: [{ role: "user", content: buildPrompt(lines) }],
      }),
    });

    if (!response.ok) return null;

    const body = await response.json();
    const toolUse = (body.content ?? []).find((block: { type: string }) => block.type === "tool_use");
    if (!toolUse) return null;

    return validateGroceryCheck(toolUse.input);
  } catch {
    return null;
  }
}
