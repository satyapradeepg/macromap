// One-shot Claude call to generate real cooking instructions for an
// AI-composed dish (2026-07-30, "AI-generated meals should have a similar
// recipe experience to real Spoonacular meals" -- Satya's explicit
// request, after noticing AI-composed cards had no "Recipe" button at
// all). By the time this runs, the dish name, every ingredient, and every
// gram amount are ALREADY fixed and already safety-checked
// (aiMealComposition.ts) -- this call is purely descriptive (how to cook
// what's already decided), it can never introduce a new ingredient or
// change a macro-relevant decision, so it carries none of that file's own
// grounding/safety risk. Same forced tool-call pattern as
// planCritic.ts, for the same reason: reliable structured
// output instead of parsing free-text.
//
// Cached per-slot (migration 0028), not globally like
// recipeInstructionsCache.ts's recipe_instructions_cache table -- an
// AI-composed dish's exact ingredient list is unique to the one slot/
// generation it was composed for, so there's no cross-user/cross-plan
// reuse value the way a real Spoonacular recipe id has.
//
// Model id: per ai-agents.md's standing note, confirm against the latest
// available Sonnet-tier model at deploy time rather than trusting this
// string indefinitely.
const MODEL = "claude-sonnet-5";

export interface AiComposedIngredientForInstructions {
  name: string;
  amountG: number;
}

const WRITE_RECIPE_STEPS_TOOL = {
  name: "write_recipe_steps",
  description: "Write clear, real cooking instructions for a dish using EXACTLY the ingredients and amounts given -- never add, remove, or change any of them.",
  input_schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: { type: "string" },
        description: "3-6 short, concrete cooking steps a home cook could actually follow, in order. Each step is one sentence or two at most.",
      },
    },
    required: ["steps"],
  },
};

function buildPrompt(dishName: string, ingredients: AiComposedIngredientForInstructions[]): string {
  const lines = ingredients.map((i) => `${Math.round(i.amountG)}g ${i.name}`).join("\n");
  return `Write real, practical cooking instructions for this dish:

"${dishName}"

Ingredients (use EXACTLY these, in EXACTLY these amounts -- never add, remove, substitute, or resize any of them):
${lines}

Write 3-6 short, concrete steps a home cook could actually follow (prep, cook, combine, serve). Assume normal kitchen equipment. Don't invent an ingredient that isn't listed above, and don't restate the exact gram amounts in the steps themselves -- the amounts are already shown separately above the instructions; just describe the technique (e.g. "dice the potato" not "dice the 120g potato").`;
}

// Never trusts the LLM's JSON shape blindly, same discipline as
// planCritic.ts's validateCritique
// -- malformed output is treated as "no instructions available," never a
// crash, and never silently shown as fewer/different ingredients than
// what was actually asked for (this function only validates step TEXT,
// the real ingredient list shown to the user always comes from the
// already-composed meal data, never from this call).
export function validateRecipeSteps(raw: unknown): string[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.steps)) return null;
  const steps = obj.steps.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  return steps.length > 0 ? steps : null;
}

// Returns null (never throws) on a missing API key, a failed request, or a
// malformed/empty response -- same "never blocks the real feature it
// supports" discipline as planCritic.ts. The caller
// (actions.ts) treats null as "instructions unavailable right now," the
// same UX a real recipe's own instructions-fetch failure already has.
export async function generateAiComposedRecipeSteps(
  dishName: string,
  ingredients: AiComposedIngredientForInstructions[],
): Promise<string[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (ingredients.length === 0) return null;

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
        tools: [WRITE_RECIPE_STEPS_TOOL],
        tool_choice: { type: "tool", name: "write_recipe_steps" },
        messages: [{ role: "user", content: buildPrompt(dishName, ingredients) }],
      }),
    });

    if (!response.ok) return null;
    const body = await response.json();
    const toolUse = (body.content ?? []).find((block: { type: string }) => block.type === "tool_use");
    if (!toolUse) return null;
    return validateRecipeSteps(toolUse.input);
  } catch {
    return null;
  }
}
