// Calls Claude to propose the COMPLETE new ingredient list for a
// chat-requested meal edit (F11) -- sibling to mealProposer.ts, same
// conventions (raw fetch, forced tool_choice, self-check field), but a
// different schema shape: every ingredient carries a REQUIRED explicit
// amountG (never optional the way fixedAmountG is in mealProposer.ts),
// because an edit never leaves anything to be target-solved -- see
// aiMealComposition.ts's composeMealFromEditDetailed, which grounds
// whatever this returns without ever solving an amount against a target.
//
// Schema decision (full-list replacement, not a diff/mutation-op schema):
// asking for a diff would require inventing op-ordering semantics and
// would still need the current list's roles re-derived anyway -- a full
// list is barely more prompt tokens (the model already has to read the
// current list to reason about the edit) and lets every existing
// grounding helper apply completely unchanged.
//
// Model id: per ai-agents.md's standing note, don't let this go stale --
// confirm against the latest available Sonnet-tier model at deploy time
// rather than trusting this string indefinitely.
const MODEL = "claude-sonnet-5";

import type { MacroTargets } from "./targets";
import type { MealEditProposal, MealRole } from "./aiMealComposition";
import { condimentRiskWarnings } from "./openEndedIngredientSafety";

export interface CurrentIngredientDescription {
  name: string;
  amount: number;
  unit: string;
}

export interface ProposeMealEditInput {
  currentDishName: string;
  currentIngredients: CurrentIngredientDescription[];
  // Classifier-extracted free text, e.g. "swap the salmon for tofu" --
  // passed through verbatim, not re-summarized.
  userInstruction: string;
  mealType: "breakfast" | "lunch" | "dinner";
  // Informational only -- NEVER solved against. Gives the model a sense
  // of scale (e.g. "roughly how big is this meal supposed to be") without
  // asking it to hit an exact number; composeMealFromEditDetailed has no
  // concept of a target at all.
  target: MacroTargets;
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
}

// Verbatim copies of mealProposer.ts's own self-check field constants --
// same per-file duplication convention as everywhere else in this
// codebase (see that file's own comment on why duplication, not a shared
// constant, is the established pattern).
const CONSTRAINT_CHECK_FIELD = {
  type: "string",
  description:
    "For EACH ingredient listed above, name it and explicitly confirm it does not conflict with any dietary style, allergy, or dislike stated in the prompt -- check hidden/derived forms too (seitan = wheat gluten, most protein powder = dairy or soy, cheese/yogurt/butter = dairy, almonds/cashews/walnuts = tree nuts, tofu/tempeh/edamame = soy). If you find a real conflict while writing this, go back and replace that ingredient above before finalizing -- never report a conflict here and submit the same ingredient anyway.",
};

const TITLE_INGREDIENT_CHECK_FIELD = {
  type: "string",
  description:
    "Check the dish name above against the ingredients you just listed: does the name mention any specific ingredient, dish component, or preparation (e.g. \"Rice Noodles\", \"Melted Cheese\", \"with Bacon\") that is NOT actually one of your listed ingredients? If you find a mismatch while writing this, go back and revise the dish name above to remove that reference before finalizing -- never name something in the title that you didn't actually include as an ingredient.",
};

// Read (unlike the two self-check fields above, which are purely
// additive and never enforced) -- validateEditProposal below normalizes
// and surfaces this directly as the assistant's chat reply on success.
// Safe to trust for DISPLAY only: it never gates a decision.
const CHANGE_SUMMARY_FIELD = {
  type: "string",
  description:
    "One short, friendly sentence describing what you changed, to show the user directly (e.g. \"Swapped the salmon for tofu and adjusted the rice slightly.\"). Write this AFTER finalizing the ingredient list above, so it accurately describes the real final result.",
};

const PROPOSE_MEAL_EDIT_TOOL = {
  name: "propose_meal_edit",
  description:
    "Propose the complete new ingredient list for a meal after applying a user's requested edit -- every ingredient (changed or not) with an explicit realistic gram amount.",
  input_schema: {
    type: "object",
    properties: {
      dishName: { type: "string", description: "The dish's name after the edit -- update it if the edit changes what the dish actually is, otherwise keep it as-is." },
      ingredients: {
        type: "array",
        description:
          "The COMPLETE new ingredient list, not just what changed -- re-list every ingredient that's staying, with essentially its current amount, alongside whatever you added/removed/adjusted.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "A real, searchable whole-food or common grocery ingredient name (not a brand name)." },
            role: { type: "string", enum: ["protein", "carb", "fat", "fixed"] },
            amountG: { type: "number", description: "A realistic, EXPLICIT gram amount for this ingredient -- required for every ingredient, including ones that aren't changing." },
          },
          required: ["name", "role", "amountG"],
        },
      },
      changeSummary: CHANGE_SUMMARY_FIELD,
      titleIngredientCheck: TITLE_INGREDIENT_CHECK_FIELD,
      constraintCheck: CONSTRAINT_CHECK_FIELD,
    },
    required: ["dishName", "ingredients", "changeSummary", "titleIngredientCheck", "constraintCheck"],
  },
};

export function buildEditPrompt(input: ProposeMealEditInput): string {
  const { currentDishName, currentIngredients, userInstruction, mealType, target, dietaryStyles, allergies, dislikes } = input;
  const condimentWarnings = condimentRiskWarnings({ dietaryStyles, allergies, dislikes });
  const currentList = currentIngredients.map((i) => `${i.name} (${i.amount} ${i.unit})`).join(", ");

  return `A user wants to edit their existing ${mealType}, currently called "${currentDishName}" with these ingredients: ${currentList}.

This meal roughly targets ${Math.round(target.calories)} calories / ${Math.round(target.proteinG)}g protein / ${Math.round(target.carbsG)}g carbs / ${Math.round(target.fatG)}g fat -- for context only, not something to solve exactly; every amount you give below is EXPLICIT and will be used as-is, never resolved against this target.

Apply this specific edit the user asked for: "${userInstruction}"

Hard constraints -- never violate these, including hidden/derived forms (e.g. mayonnaise contains egg, Worcestershire sauce contains fish, most protein powder/seitan is not gluten-free; if halal or kosher is listed below, that means no pork/bacon/ham and no alcohol/wine/beer/rum as an ingredient -- gelatin and marshmallows are frequently pork-derived, and a wine/beer-based sauce or marinade still counts even if it's "cooked off"; kosher additionally means no shellfish):
- Dietary style: ${dietaryStyles.length ? dietaryStyles.join(", ") : "none"}
- Allergies (absolute, safety-critical -- think about hidden forms, not just the literal word): ${allergies.length ? allergies.join(", ") : "none"}
- Dislikes (avoid these ingredients entirely): ${dislikes.length ? dislikes.join(", ") : "none"}
${condimentWarnings.length ? `\nFor any "fixed" role ingredient specifically, do NOT reach for: ${condimentWarnings.join("; ")} -- these are common flavorings/garnishes that conflict with the constraints above.` : ""}

Requirements:
1. Return the COMPLETE new ingredient list, not a diff -- re-list every ingredient that isn't changing with essentially its current amount, alongside whatever you're adding, removing, or adjusting per the user's request.
2. Apply the user's requested edit precisely -- don't make unrelated changes to ingredients they didn't ask about.
3. Give every ingredient a realistic, EXPLICIT gram amount. If the user asked for a relative change ("double the chicken", "a bit less rice"), compute the new gram amount yourself from the current amount given above.
4. Use real, specific, searchable ingredient names (e.g. "seitan cutlets", not "protein source").
5. It's fine for the resulting dish to have no ingredient in a given role (e.g. dropping the carb entirely) if that's what the user asked for -- don't invent a replacement they didn't request.
6. Fill in "changeSummary" after finalizing the ingredient list, describing what actually changed.
7. Fill in "titleIngredientCheck" next: re-read the dish name and confirm it doesn't name any ingredient, component, or preparation that isn't actually in your final ingredients list. If you find a mismatch, revise the dish name before finalizing.
8. Fill in "constraintCheck" LAST -- go through each final ingredient by name and confirm it doesn't conflict with the dietary style, allergies, or dislikes listed above, including hidden/derived forms. If you find a real conflict, go back and swap that ingredient before submitting.`;
}

const VALID_ROLES: MealRole[] = ["protein", "carb", "fat", "fixed"];
const MAX_CHANGE_SUMMARY_LENGTH = 140;
const FALLBACK_CHANGE_SUMMARY = "Updated the meal.";

// Never trusts the LLM's JSON shape blindly, same discipline as
// mealProposer.ts's validateProposal. Unlike that function, amountG is
// REQUIRED and must be a finite number on every ingredient -- an edit
// never leaves an amount unsolved, so a missing/non-numeric one is
// malformed input, not a legitimate default case.
export function validateEditProposal(raw: unknown): MealEditProposal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.dishName !== "string" || !obj.dishName.trim()) return null;
  if (!Array.isArray(obj.ingredients) || obj.ingredients.length === 0) return null;

  const ingredients = [];
  for (const item of obj.ingredients) {
    if (typeof item !== "object" || item === null) return null;
    const i = item as Record<string, unknown>;
    if (typeof i.name !== "string" || !i.name.trim()) return null;
    if (typeof i.role !== "string" || !VALID_ROLES.includes(i.role as MealRole)) return null;
    if (typeof i.amountG !== "number" || !Number.isFinite(i.amountG) || i.amountG <= 0) return null;
    ingredients.push({ name: i.name, role: i.role as MealRole, amountG: i.amountG });
  }

  const rawSummary = typeof obj.changeSummary === "string" ? obj.changeSummary.trim() : "";
  const changeSummary = rawSummary && rawSummary.length <= MAX_CHANGE_SUMMARY_LENGTH ? rawSummary : FALLBACK_CHANGE_SUMMARY;

  return { dishName: obj.dishName, ingredients, changeSummary };
}

// Degrades (returns null), never throws -- unlike mealProposer.ts's
// proposeMealViaClaude/planCritic.ts's critiquePlan, which throw because
// orchestrate.ts's generation loop has a purpose-built try/catch around
// them. This is called from a single-shot chat request/response
// (chatActions.ts), where "return null -> a generic can't-process-that
// reply" is simpler and matches 6 of this codebase's 8 existing Claude
// call sites.
export async function proposeMealEditViaClaude(input: ProposeMealEditInput): Promise<MealEditProposal | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

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
      tools: [PROPOSE_MEAL_EDIT_TOOL],
      tool_choice: { type: "tool", name: "propose_meal_edit" },
      messages: [{ role: "user", content: buildEditPrompt(input) }],
    }),
  });

  if (!response.ok) return null;

  const body = await response.json();
  const toolUse = (body.content ?? []).find((block: { type: string }) => block.type === "tool_use");
  if (!toolUse) return null;

  return validateEditProposal(toolUse.input);
}
