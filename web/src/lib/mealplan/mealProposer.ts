// Calls Claude to propose WHAT belongs in a dish for a genuinely blocked
// meal slot -- the one piece of judgment in this file; everything else
// (macros, sizing, safety, portion realism) is deterministic, per
// aiMealComposition.ts's grounding rule. Forces a tool call for
// structured output rather than parsing free-text JSON, since a
// malformed/prose response would otherwise need fragile parsing.
//
// Model id: per ai-agents.md's standing note, don't let this go stale --
// confirm against the latest available Sonnet-tier model at deploy time
// rather than trusting this string indefinitely.
const MODEL = "claude-sonnet-5";

import type { MacroTargets } from "./targets";
import type { MealProposal, MealRole } from "./aiMealComposition";

export interface ProposeMealInput {
  mealType: "breakfast" | "lunch" | "dinner";
  target: MacroTargets;
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
  pantryItemNames: string[];
}

const PROPOSE_MEAL_TOOL = {
  name: "propose_meal",
  description: "Propose a real, realistic dish and its ingredient list to fill a meal slot.",
  input_schema: {
    type: "object",
    properties: {
      dishName: { type: "string", description: "A real, specific dish name a person would recognize, e.g. 'Seitan Scramble with Spinach and Whole Wheat Toast'." },
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "A real, searchable whole-food or common grocery ingredient name (not a brand name)." },
            role: { type: "string", enum: ["protein", "carb", "fat", "fixed"] },
            fixedAmountG: { type: "number", description: "Only for role='fixed' (a small garnish/aromatic): a realistic gram amount, e.g. 40 for a side of spinach." },
          },
          required: ["name", "role"],
        },
      },
    },
    required: ["dishName", "ingredients"],
  },
};

export function buildPrompt(input: ProposeMealInput): string {
  const { mealType, target, dietaryStyles, allergies, dislikes, pantryItemNames } = input;
  return `Propose a realistic ${mealType} to hit these targets as closely as a normal-sized portion reasonably can:
- ${Math.round(target.calories)} calories
- ${Math.round(target.proteinG)}g protein
- ${Math.round(target.carbsG)}g carbs
- ${Math.round(target.fatG)}g fat

Hard constraints -- never violate these, including hidden/derived forms (e.g. mayonnaise contains egg, Worcestershire sauce contains fish, most protein powder/seitan is not gluten-free):
- Dietary style: ${dietaryStyles.length ? dietaryStyles.join(", ") : "none"}
- Allergies (absolute, safety-critical -- think about hidden forms, not just the literal word): ${allergies.length ? allergies.join(", ") : "none"}
- Dislikes (avoid these ingredients entirely): ${dislikes.length ? dislikes.join(", ") : "none"}

${pantryItemNames.length ? `Pantry on hand (prefer using these where they genuinely fit the dish, but never at the expense of the constraints above or of realism): ${pantryItemNames.join(", ")}` : ""}

Requirements for your proposal:
1. Name a REAL, coherent, recognizable dish for ${mealType} -- not an arbitrary bag of ingredients. Someone should read the name and immediately picture a real meal.
2. Pick exactly one ingredient for each of the "protein", "carb", and "fat" roles, plus 0-2 small "fixed" ones for realism (a vegetable side, a garnish, a spice) -- fixed ones don't need to hit any macro, just be a normal small serving.
3. The "protein" ingredient MUST be dense enough to plausibly hit the protein target within a NORMAL single-meal portion (roughly 100-250g). Do not pick a low-density ingredient like plain tofu for a demanding protein target and expect a huge portion to make up for it -- pick something that's actually protein-dense enough (e.g. seitan, tempeh, lentils, a dense cheese, a lean meat if the diet allows it) for how much protein is actually needed here.
4. Use real, specific, searchable ingredient names (e.g. "seitan cutlets", not "protein source").`;
}

export async function proposeMealViaClaude(input: ProposeMealInput): Promise<MealProposal | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      tools: [PROPOSE_MEAL_TOOL],
      tool_choice: { type: "tool", name: "propose_meal" },
      messages: [{ role: "user", content: buildPrompt(input) }],
    }),
  });

  if (!response.ok) return null;

  const body = await response.json();
  const toolUse = (body.content ?? []).find((block: { type: string }) => block.type === "tool_use");
  if (!toolUse) return null;

  return validateProposal(toolUse.input);
}

const VALID_ROLES: MealRole[] = ["protein", "carb", "fat", "fixed"];

// Never trusts the LLM's JSON shape blindly -- malformed output returns
// null (same "never fake progress" discipline as everywhere else), which
// the caller treats as a failed composition attempt, not a crash.
export function validateProposal(raw: unknown): MealProposal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.dishName !== "string" || !obj.dishName.trim()) return null;
  if (!Array.isArray(obj.ingredients)) return null;

  const ingredients = [];
  for (const item of obj.ingredients) {
    if (typeof item !== "object" || item === null) return null;
    const i = item as Record<string, unknown>;
    if (typeof i.name !== "string" || !i.name.trim()) return null;
    if (typeof i.role !== "string" || !VALID_ROLES.includes(i.role as MealRole)) return null;
    if (i.role === "fixed" && typeof i.fixedAmountG !== "number") return null;
    ingredients.push({
      name: i.name,
      role: i.role as MealRole,
      fixedAmountG: typeof i.fixedAmountG === "number" ? i.fixedAmountG : undefined,
    });
  }

  return { dishName: obj.dishName, ingredients };
}
