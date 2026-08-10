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
  // Retry-with-feedback (2026-08-09, live-confirmed model-consistency
  // issue): a real recipe with several ingredients can get an
  // inconsistent role assignment across separate calls for the exact same
  // request (e.g. two ingredients both tagged "protein"), rejected
  // deterministically by composeMealFromEditDetailed's duplicate_role
  // check. Same shape/convention as mealProposer.ts's own
  // priorAttemptFeedback -- one bounded retry, telling the model
  // specifically what was wrong last time rather than blindly hoping a
  // second draw happens to differ.
  priorAttemptFeedback?: string;
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
//
// Live-confirmed 2026-08-09: constraintCheck (above) already tells the
// model to swap out a conflicting ingredient before submitting -- and it
// reliably does. The gap was entirely downstream: when the model honors a
// user's request only partially or not at all (e.g. asked to add
// almonds/dry sherry, declined for a nut allergy/halal diet, either left
// the meal unchanged or made some other change instead), the OLD
// changeSummary instruction only ever asked "what did you change," never
// "did you have to deviate from what they literally asked, and why" -- so
// a real decline surfaced as a generic, confusing reply that never
// mentioned the actual reason. Explicitly requiring that disclosure here
// fixes it at the source, for every downstream caller that reads
// changeSummary (chatActions.ts's success AND no-op replies both do).
const CHANGE_SUMMARY_FIELD = {
  type: "string",
  description:
    'One short, friendly sentence describing what you changed, to show the user directly (e.g. "Swapped the salmon for tofu and adjusted the rice slightly."). If you had to decline or modify what the user literally asked for because of a dietary style/allergy/dislike conflict, this sentence MUST say so plainly and say what you did instead (e.g. "Couldn\'t add almonds since you\'re allergic to nuts -- left the meal unchanged." or "Swapped in agave nectar instead of honey to keep this vegan."). Never write a generic summary that hides a declined or substituted ingredient. Write this AFTER finalizing the ingredient list above, so it accurately describes the real final result.',
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
            isPreExisting: {
              type: "boolean",
              description:
                "true if this is essentially the SAME ingredient already in the current list above -- even if you renamed it, cleaned up how it's phrased, fixed an odd/misspelled name, or just adjusted its amount. false ONLY for a genuinely NEW ingredient this edit is adding for the first time. Set this for EVERY ingredient, not just ones you changed.",
            },
            searchTerm: {
              type: "string",
              description:
                "A plain, generic, brand-free version of this ingredient's name, suitable for looking up nutrition data -- e.g. for name \"karo corn syrup\" use \"corn syrup\"; for name \"fresh spinach\" use \"spinach\". If the name is already plain and generic, just repeat it here unchanged. Set this for EVERY ingredient.",
            },
          },
          required: ["name", "role", "amountG", "isPreExisting", "searchTerm"],
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
  const { currentDishName, currentIngredients, userInstruction, mealType, target, dietaryStyles, allergies, dislikes, priorAttemptFeedback } = input;
  const condimentWarnings = condimentRiskWarnings({ dietaryStyles, allergies, dislikes });
  const currentList = currentIngredients.map((i) => `${i.name} (${i.amount} ${i.unit})`).join(", ");

  return `A user wants to edit their existing ${mealType}, currently called "${currentDishName}" with these ingredients: ${currentList}.

This meal roughly targets ${Math.round(target.calories)} calories / ${Math.round(target.proteinG)}g protein / ${Math.round(target.carbsG)}g carbs / ${Math.round(target.fatG)}g fat -- for context only, not something to solve exactly; every amount you give below is EXPLICIT and will be used as-is, never resolved against this target.

Apply this specific edit the user asked for: "${userInstruction}"
${priorAttemptFeedback ? `\nIMPORTANT -- your previous proposal for this exact edit was rejected: ${priorAttemptFeedback} Fix this specific problem in your new proposal below; don't just repeat the same choice.\n` : ""}

Hard constraints -- never violate these, including hidden/derived forms (e.g. mayonnaise contains egg, Worcestershire sauce contains fish, most protein powder/seitan is not gluten-free; if halal or kosher is listed below, that means no pork/bacon/ham and no alcohol/wine/beer/rum as an ingredient -- gelatin and marshmallows are frequently pork-derived, and a wine/beer-based sauce or marinade still counts even if it's "cooked off"; kosher additionally means no shellfish):
- Dietary style: ${dietaryStyles.length ? dietaryStyles.join(", ") : "none"}
- Allergies (absolute, safety-critical -- think about hidden forms, not just the literal word): ${allergies.length ? allergies.join(", ") : "none"}
- Dislikes (avoid these ingredients entirely): ${dislikes.length ? dislikes.join(", ") : "none"}
${condimentWarnings.length ? `\nFor any "fixed" role ingredient specifically, do NOT reach for: ${condimentWarnings.join("; ")} -- these are common flavorings/garnishes that conflict with the constraints above.` : ""}

Requirements:
1. Return the COMPLETE new ingredient list, not a diff -- re-list every ingredient that isn't changing with essentially its current amount, alongside whatever you're adding, removing, or adjusting per the user's request. For EACH ingredient, set "isPreExisting": true if it's the same ingredient as one already in the current list (even if you renamed it, fixed an odd/misspelled name, or just adjusted its amount), or false if it's a genuinely new addition -- you already know this while deciding what to write, so state it directly rather than leaving it to be guessed from the name alone. Also set "searchTerm" for EACH ingredient to a plain, generic, brand-free version of its name suitable for a nutrition-database lookup (e.g. name "karo corn syrup" -> searchTerm "corn syrup"; name "fresh spinach" -> searchTerm "spinach") -- if the name is already plain and generic, just repeat it as the searchTerm. For a regional/foreign ingredient name, the searchTerm must be a genuinely DIFFERENT, more common alternative, not the same name restated -- e.g. name "chana dal (split chickpeas), cooked" -> searchTerm "split chickpeas" or "chana dal" (NOT "chana dal (split chickpeas), cooked" again); name "idli rice (parboiled rice)" -> searchTerm "parboiled rice" or "rice". A nutrition database doesn't parse parentheses or descriptive clauses as part of a food name.
2. Apply the user's requested edit precisely -- don't make unrelated changes to ingredients they didn't ask about.
3. Give every ingredient a realistic, EXPLICIT gram amount. If the user asked for a relative change ("double the chicken", "a bit less rice"), compute the new gram amount yourself from the current amount given above.
4. Use real, specific, searchable ingredient names (e.g. "seitan cutlets", not "protein source").
5. It's fine for the resulting dish to have no ingredient in a given role (e.g. dropping the carb entirely) if that's what the user asked for -- don't invent a replacement they didn't request.
6. EXACTLY ONE ingredient may have role "protein", EXACTLY ONE may have role "carb", and EXACTLY ONE may have role "fat" -- never two or more of the same one of these three. This matters most for a real recipe with several ingredients that could each plausibly seem protein-ish or carb-ish: pick the single most macro-relevant one for each role and put every other ingredient under "fixed", even ones that don't feel like a garnish (a cooking liquid, a second vegetable, a sauce base are all "fixed" if they're not THE ingredient carrying that role's macros).
7. Fill in "changeSummary" after finalizing the ingredient list, describing what actually changed. If the user's literal request conflicted with a dietary style/allergy/dislike and you declined it or substituted something else (per the constraint check below), say so explicitly here -- name what they asked for, what you did instead, and why. Don't let changeSummary describe a request as fulfilled when it wasn't.
8. Fill in "titleIngredientCheck" next: re-read the dish name and confirm it doesn't name any ingredient, component, or preparation that isn't actually in your final ingredients list. If you find a mismatch, revise the dish name before finalizing.
9. Fill in "constraintCheck" LAST -- go through each final ingredient by name and confirm it doesn't conflict with the dietary style, allergies, or dislikes listed above, including hidden/derived forms. If you find a real conflict, go back and swap that ingredient before submitting.`;
}

const VALID_ROLES: MealRole[] = ["protein", "carb", "fat", "fixed"];
const MAX_CHANGE_SUMMARY_LENGTH = 140;
// Exported so chatActions.ts's no-op reply branch can tell a real,
// model-written explanation (which it should show) apart from this
// generic placeholder (which it shouldn't prefer over its own existing
// no-op message) -- see the 2026-08-09 no-op-masking fix there.
export const FALLBACK_CHANGE_SUMMARY = "Updated the meal.";

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
    // Defensive, not strict, unlike amountG above -- this is a low-stakes
    // bookkeeping signal (see EditedIngredient's doc comment), not a
    // safety-critical one, so a missing/malformed value degrades to
    // "no explicit signal" (falls back to the string-match backstop)
    // rather than invalidating the whole proposal over it.
    const isPreExisting = i.isPreExisting === true;
    // Same defensive treatment as isPreExisting above -- a missing/empty/
    // non-string searchTerm just means no last-resort fallback is
    // available for this ingredient (today's exact behavior), not an
    // invalid proposal. Also skips a searchTerm that's identical to name
    // (the common case), since lookupIngredientMacros already guards
    // against re-searching the same string.
    const rawSearchTerm = typeof i.searchTerm === "string" ? i.searchTerm.trim() : "";
    const searchTerm = rawSearchTerm && rawSearchTerm.toLowerCase() !== i.name.trim().toLowerCase() ? rawSearchTerm : undefined;
    ingredients.push({ name: i.name, role: i.role as MealRole, amountG: i.amountG, isPreExisting, searchTerm });
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
