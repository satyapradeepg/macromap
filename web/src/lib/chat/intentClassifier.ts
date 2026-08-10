// Classifies a free-text chat message into one or more structured
// intents for the conversational plan assistant (F11). Follows this
// codebase's universal Claude call-site convention (raw fetch, no SDK,
// forced tool_choice, self-check field, never-trust-the-shape validator)
// -- see mealProposer.ts for the sibling this was modeled on.
//
// Deliberately a single forced-tool-choice classifier + a deterministic
// router (chatActions.ts), not an open multi-tool "agentic loop" --
// every one of this codebase's existing Claude call sites forces
// tool_choice to one named tool; none thread multi-turn tool-result
// history. Returns an ARRAY of intents (not one) so a compound message
// ("remove the onions and swap tomorrow's lunch") resolves in a single
// classification call instead of requiring a second round-trip.
//
// Model id: per ai-agents.md's standing note, don't let this go stale --
// confirm against the latest available Sonnet-tier model at deploy time
// rather than trusting this string indefinitely.
const MODEL = "claude-sonnet-5";

import type { MealType } from "@/lib/mealplan/targets";

// pantry_contents added 2026-08-09 (live bug found via production chat
// testing): "What's in my pantry?" had no topic to land on at all and
// fell to 'unsupported', whose message hardcodes budget/cost as the named
// example regardless of what was actually asked -- see
// answerReadOnlyQuestion.ts's own comment on that second, independent fix.
export type QaTopic = "remaining_weekly_macros" | "specific_meal_details" | "today_summary" | "pantry_contents" | "unsupported";

export type ProfileOperation =
  | { field: "dietaryStyles" | "allergies" | "dislikes"; action: "add" | "remove"; value: string }
  | { field: "weightKg" | "heightCm" | "age" | "activityLevel" | "goal" | "biologicalSex"; action: "set"; value: string };

export type ClassifiedIntent =
  | { kind: "swap_meal"; dayIndex: number; mealType: MealType }
  | { kind: "edit_meal_recipe"; dayIndex: number; mealType: MealType; editInstruction: string }
  | {
      kind: "edit_pantry";
      operations: Array<{ action: "add" | "remove"; itemName: string; quantityText: string | null; amount: number | null; unit: string | null }>;
    }
  | { kind: "edit_profile"; operations: ProfileOperation[] }
  | { kind: "read_only_qa"; qaTopic: QaTopic; dayIndex: number | null; mealType: MealType | null }
  // Fallback path for the clamp-confirmation flow (F11 meal editing) --
  // chatActions.ts's own cheap deterministic yes/no keyword check handles
  // the common case BEFORE this classifier even runs; this intent only
  // fires when that check couldn't confidently tell (an ambiguous
  // response to a pending clamp offer).
  | { kind: "confirm_pending_action"; confirmed: boolean }
  | { kind: "clarify"; message: string }
  | { kind: "refuse"; message: string };

export interface ClassifyChatIntentInput {
  message: string;
  resolvedDayIndex: number | null;
  resolvedMatchedPhrase: string | null;
  todayWeekdayName: string;
  // Set only when the assistant's PREVIOUS message offered a specific
  // suggestion the user hasn't responded to yet (the clamp-confirmation
  // flow, F11 meal editing) -- a plain-English summary of what's pending,
  // so the model can recognize a yes/no reply in that context via
  // confirm_pending_action. chatActions.ts's own cheap deterministic
  // keyword check handles the common case before this classifier even
  // runs; this is only reached when that check couldn't confidently tell.
  pendingSuggestion: string | null;
}

const MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner", "snack1", "snack2"];
const PROFILE_LIST_FIELDS = ["dietaryStyles", "allergies", "dislikes"] as const;
const PROFILE_SET_FIELDS = ["weightKg", "heightCm", "age", "activityLevel", "goal", "biologicalSex"] as const;
const QA_TOPICS: QaTopic[] = ["remaining_weekly_macros", "specific_meal_details", "today_summary", "pantry_contents", "unsupported"];

// Self-check field, same mechanical shape/positioning as mealProposer.ts's
// titleIngredientCheck/constraintCheck -- REQUIRED, placed last, purely
// additive (validateIntentClassification never reads or enforces its
// content), asks Claude to re-derive its own answer as a genuine second
// pass rather than trusting the first draft.
const SELF_CHECK_FIELD = {
  type: "string",
  description:
    "Re-read the user's message once more against the intent(s) and fields you just chose above. Confirm each intent's fields are actually complete and consistent with what the user asked -- if you find a mismatch while writing this, go back and fix the intent(s) above before finalizing.",
};

const CLASSIFY_INTENT_TOOL = {
  name: "classify_chat_intent",
  description:
    "Classify a user's chat message into one or more structured intents for a meal-planning assistant.",
  input_schema: {
    type: "object",
    properties: {
      intents: {
        type: "array",
        description:
          "One entry per distinct request in the message -- most messages have exactly one, but a compound message (\"remove the onions and swap tomorrow's lunch\") needs two.",
        items: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              enum: ["swap_meal", "edit_meal_recipe", "edit_pantry", "edit_profile", "read_only_qa", "confirm_pending_action", "clarify", "refuse"],
            },
            dayIndex: {
              type: "number",
              description:
                "For swap_meal/edit_meal_recipe (required) or read_only_qa about a specific meal: which day, 0=today through 6. Prefer the resolved day hint given in the prompt when the message's day reference matches it.",
            },
            mealType: {
              type: "string",
              enum: MEAL_TYPES,
              description: "For swap_meal/edit_meal_recipe (required) or read_only_qa about a specific meal.",
            },
            editInstruction: {
              type: "string",
              description:
                "For edit_meal_recipe only (required) -- the user's requested change, verbatim or lightly cleaned up. Can be a small tweak ('remove the onions', 'double the chicken', 'swap the rice for quinoa') OR a full description of a completely different dish the user named or described ('change it to a masala dosa with paneer and potato', 'make it injera with a lentil stew') -- pass the WHOLE description through either way, never shorten it down to just a dish name.",
            },
            confirmed: {
              type: "boolean",
              description: "For confirm_pending_action only (required) -- true if the user is agreeing to the pending suggestion, false if declining.",
            },
            pantryOperations: {
              type: "array",
              description: "For edit_pantry only.",
              items: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["add", "remove"] },
                  itemName: { type: "string" },
                  quantityText: { type: "string", description: "Free-text quantity if the user gave one, e.g. '2 lbs'. Omit if none was mentioned." },
                  amount: {
                    type: "number",
                    description:
                      "For add only, if the user gave a clear numeric quantity: the number alone (e.g. 2 for '2 lbs', 500 for '500g'). Omit if no clear number was given.",
                  },
                  unit: {
                    type: "string",
                    description:
                      "For add only, paired with amount: the unit word as the user said it (e.g. 'lb', 'lbs', 'g', 'kg', 'oz', 'cup', 'can'). Omit unless amount is also set.",
                  },
                },
                required: ["action", "itemName"],
              },
            },
            profileOperations: {
              type: "array",
              description: "For edit_profile only. Diet/allergy/dislike use add/remove against the existing list; weight/height/age/activity/goal/sex use set (a full replacement value).",
              items: {
                type: "object",
                properties: {
                  field: { type: "string", enum: [...PROFILE_LIST_FIELDS, ...PROFILE_SET_FIELDS] },
                  action: { type: "string", enum: ["add", "remove", "set"] },
                  value: {
                    type: "string",
                    description:
                      "For add/remove: the single item text (e.g. 'peanuts'), or for dietaryStyles one of vegetarian/vegan/gluten_free/dairy_free/halal/kosher. For set: weightKg's value MUST be in POUNDS as a plain number string (convert if the user gave kg, e.g. '80kg' -> '176'); heightCm's value MUST be in TOTAL INCHES as a plain number string (convert if the user gave feet/inches, e.g. \"5'10\" -> '70'); age is a plain integer string; activityLevel is one of sedentary/lightly_active/active/very_active; goal is one of cut/bulk/maintain; biologicalSex is male/female.",
                  },
                },
                required: ["field", "action", "value"],
              },
            },
            qaTopic: {
              type: "string",
              enum: QA_TOPICS,
              description:
                "For read_only_qa only. Use 'unsupported' for anything not covered by the other four (including any question about budget/grocery cost, which this assistant deliberately does not answer).",
            },
            message: {
              type: "string",
              description: "For clarify (a question to ask the user back) or refuse (why the request can't be done) only.",
            },
          },
          required: ["intent"],
        },
      },
      selfCheck: SELF_CHECK_FIELD,
    },
    required: ["intents", "selfCheck"],
  },
};

export function buildIntentClassificationPrompt(input: ClassifyChatIntentInput): string {
  const { message, resolvedDayIndex, resolvedMatchedPhrase, todayWeekdayName, pendingSuggestion } = input;
  return `A user of a meal-planning app sent this chat message: "${message}"

Today is ${todayWeekdayName}. This app's plan is a rolling 7-day window with no fixed Monday-Sunday week. Internally each day has a dayIndex from 0 (today) through 6 (six days from now) -- but the app's own UI never shows that number to the user; it labels the same days "Day 1" (today) through "Day 7" (six days from now), 1-indexed. If the user says "day N" matching those on-screen labels, that means dayIndex = N-1 (e.g. "day 7" = dayIndex 6, the last day -- NOT out of range). If you ever need to ask a clarifying question that mentions a day, always phrase it using the UI's "Day N" labels (what the user actually sees), never the internal dayIndex number -- telling a user "there's no day 7" when the UI's own last tab is literally labeled "Day 7" is exactly the confusing mistake to avoid.
This mapping is ONLY valid for N from 1 through 7 -- dayIndex must always end up between 0 and 6, never anything else. Live-confirmed 2026-08-09: for a message like "swap day 8's lunch," do NOT mechanically compute dayIndex = 8-1 = 7 and emit a swap_meal/edit_meal_recipe/read_only_qa intent with it anyway -- 7 is out of range and that entire response gets rejected as invalid, silently failing the whole request with no fallback. Any day number outside 1-7 (0, 8, 9, or anything else) is NOT a valid on-screen day at all -- always use 'clarify' instead, asking which day (Day 1 through Day 7) they actually meant, the same way you'd handle any other day you can't confidently resolve.
${resolvedDayIndex !== null ? `A deterministic parser already resolved a day reference in this message ("${resolvedMatchedPhrase}") to dayIndex ${resolvedDayIndex} -- use this exact value for any intent that needs a day, don't re-derive it yourself.` : "No day reference was deterministically resolved from this message -- if an intent needs a specific day and you genuinely can't tell which one, use 'clarify' instead of guessing."}
${pendingSuggestion ? `\nThe assistant's PREVIOUS message offered this pending suggestion, which the user hasn't confirmed or declined yet: "${pendingSuggestion}". If this message reads as a response to that (agreeing, declining, or is otherwise ambiguous about it), use confirm_pending_action. If it's clearly about something else entirely, ignore the pending suggestion and classify normally.` : ""}

Classify this message into one or more of these intents:
- swap_meal: the user wants a DIFFERENT meal but does NOT say what it should actually be -- "swap tonight's dinner", "I don't like this, give me something else", "change lunch to something different". There is nothing here for you to act on beyond "not this one" -- swap_meal has no field for a dish description at all, it just picks a different real recipe automatically. Needs dayIndex and mealType.
- edit_meal_recipe: the user describes what the meal should actually contain or be -- this covers BOTH a small ingredient-level tweak (a quantity, adding/removing one ingredient, substituting one ingredient) AND a full replacement described by name, cuisine, or ingredient list, e.g. "remove the onions from tonight's dinner", "double the chicken in tomorrow's lunch", "swap the rice for quinoa", "change breakfast to a masala dosa with paneer", "make dinner injera with a lentil stew", "turn lunch into falafel with hummus". Live-confirmed mistake to avoid (2026-08-10): a message naming a specific, completely different dish is still edit_meal_recipe, NEVER swap_meal, even though it sounds like a "wholesale replacement" -- the deciding question is only "did the user say what they want it to be," not "how much is changing." If they named or described it at all, however different from what's there now, use edit_meal_recipe with that full description as editInstruction; swap_meal has no way to honor it. Needs dayIndex, mealType, and editInstruction.
- edit_pantry: the user is telling you what they have or don't have on hand (e.g. "I have chicken and rice", "I used up the eggs"). Needs pantryOperations.
- edit_profile: the user wants to change something about their diet, allergies, dislikes, weight, height, age, activity level, or goal. Needs profileOperations. Diet/allergy/dislike changes are add/remove against their existing list (e.g. "I'm allergic to peanuts now" = add; "I'm not vegan anymore" = remove), never a full replacement. Weight/height/age/activity/goal/sex changes are a set (a new value).
- read_only_qa: the user is asking a question, not asking for a change. Needs qaTopic ('remaining_weekly_macros' for "how many calories/protein/etc do I have left this week", 'specific_meal_details' for "what's in tonight's dinner" -- also set dayIndex/mealType for this one, 'today_summary' for a general "what's today look like", 'pantry_contents' for "what's in my pantry"/"what do I have on hand", 'unsupported' for anything else, e.g. budget/cost questions or something entirely unrelated to meal planning).
- confirm_pending_action: ONLY valid when a "pending suggestion" paragraph appears above, naming exactly what's pending -- that is the ONLY signal this intent exists at all. If that paragraph is absent from this prompt, there is NOTHING pending, full stop -- a short reply like "yes", "go ahead", or "yes day 6" with no pending-suggestion paragraph above is answering something else (most often a clarify question you or a prior turn asked) and must be classified as whatever normal intent it actually resolves to, never confirm_pending_action. A previous clarify question is NOT a pending suggestion and never enables this intent.
- clarify: you genuinely cannot tell what the user wants well enough to act (which day, which meal, what change) -- ask a short, specific question back in the message field. Never guess and execute when this is the better fit.
- refuse: the request is clearly outside what this assistant can do (e.g. asking to change the budget, which is intentionally not exposed here) -- explain why in the message field. This is different from a hard-constraint safety refusal, which happens deterministically downstream, not here -- don't try to pre-judge allergy/diet conflicts yourself; classify the request normally (e.g. still emit edit_pantry, swap_meal, or edit_meal_recipe) and let the app's own safety checks catch a real conflict.

Return one entry per distinct request in the message. Most messages have exactly one.`;
}

const VALID_MEAL_TYPES = new Set(MEAL_TYPES);
const VALID_QA_TOPICS = new Set(QA_TOPICS);
const VALID_LIST_FIELDS = new Set<string>(PROFILE_LIST_FIELDS);
const VALID_SET_FIELDS = new Set<string>(PROFILE_SET_FIELDS);

function validateOneIntent(raw: unknown): ClassifiedIntent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  switch (obj.intent) {
    case "swap_meal": {
      if (typeof obj.dayIndex !== "number" || !Number.isInteger(obj.dayIndex) || obj.dayIndex < 0 || obj.dayIndex > 6) return null;
      if (typeof obj.mealType !== "string" || !VALID_MEAL_TYPES.has(obj.mealType as MealType)) return null;
      return { kind: "swap_meal", dayIndex: obj.dayIndex, mealType: obj.mealType as MealType };
    }
    case "edit_meal_recipe": {
      if (typeof obj.dayIndex !== "number" || !Number.isInteger(obj.dayIndex) || obj.dayIndex < 0 || obj.dayIndex > 6) return null;
      if (typeof obj.mealType !== "string" || !VALID_MEAL_TYPES.has(obj.mealType as MealType)) return null;
      if (typeof obj.editInstruction !== "string" || !obj.editInstruction.trim()) return null;
      return { kind: "edit_meal_recipe", dayIndex: obj.dayIndex, mealType: obj.mealType as MealType, editInstruction: obj.editInstruction };
    }
    case "edit_pantry": {
      if (!Array.isArray(obj.pantryOperations) || obj.pantryOperations.length === 0) return null;
      const operations: Array<{ action: "add" | "remove"; itemName: string; quantityText: string | null; amount: number | null; unit: string | null }> =
        [];
      for (const op of obj.pantryOperations) {
        if (typeof op !== "object" || op === null) return null;
        const o = op as Record<string, unknown>;
        if (o.action !== "add" && o.action !== "remove") return null;
        if (typeof o.itemName !== "string" || !o.itemName.trim()) return null;
        // Require both or neither, same as addPantryItem's own contract --
        // a malformed one-sided pair (model gave a unit but no number, or
        // vice versa) is treated as "no structured quantity" rather than
        // rejecting the whole operation over it.
        const hasAmount = typeof o.amount === "number" && Number.isFinite(o.amount) && o.amount > 0;
        const hasUnit = typeof o.unit === "string" && o.unit.trim().length > 0;
        operations.push({
          action: o.action,
          itemName: o.itemName,
          quantityText: typeof o.quantityText === "string" && o.quantityText.trim() ? o.quantityText : null,
          amount: hasAmount && hasUnit ? (o.amount as number) : null,
          unit: hasAmount && hasUnit ? (o.unit as string).trim() : null,
        });
      }
      return { kind: "edit_pantry", operations };
    }
    case "edit_profile": {
      if (!Array.isArray(obj.profileOperations) || obj.profileOperations.length === 0) return null;
      const operations: ProfileOperation[] = [];
      for (const op of obj.profileOperations) {
        if (typeof op !== "object" || op === null) return null;
        const o = op as Record<string, unknown>;
        if (typeof o.field !== "string" || typeof o.value !== "string" || !o.value.trim()) return null;
        if (VALID_LIST_FIELDS.has(o.field)) {
          if (o.action !== "add" && o.action !== "remove") return null;
          operations.push({ field: o.field as "dietaryStyles" | "allergies" | "dislikes", action: o.action, value: o.value });
        } else if (VALID_SET_FIELDS.has(o.field)) {
          if (o.action !== "set") return null;
          operations.push({
            field: o.field as "weightKg" | "heightCm" | "age" | "activityLevel" | "goal" | "biologicalSex",
            action: "set",
            value: o.value,
          });
        } else {
          return null;
        }
      }
      return { kind: "edit_profile", operations };
    }
    case "read_only_qa": {
      if (typeof obj.qaTopic !== "string" || !VALID_QA_TOPICS.has(obj.qaTopic as QaTopic)) return null;
      const dayIndex =
        typeof obj.dayIndex === "number" && Number.isInteger(obj.dayIndex) && obj.dayIndex >= 0 && obj.dayIndex <= 6
          ? obj.dayIndex
          : null;
      const mealType = typeof obj.mealType === "string" && VALID_MEAL_TYPES.has(obj.mealType as MealType) ? (obj.mealType as MealType) : null;
      return { kind: "read_only_qa", qaTopic: obj.qaTopic as QaTopic, dayIndex, mealType };
    }
    case "confirm_pending_action": {
      if (typeof obj.confirmed !== "boolean") return null;
      return { kind: "confirm_pending_action", confirmed: obj.confirmed };
    }
    case "clarify": {
      if (typeof obj.message !== "string" || !obj.message.trim()) return null;
      return { kind: "clarify", message: obj.message };
    }
    case "refuse": {
      if (typeof obj.message !== "string" || !obj.message.trim()) return null;
      return { kind: "refuse", message: obj.message };
    }
    default:
      return null;
  }
}

// Never trusts the LLM's JSON shape blindly, same discipline as
// mealProposer.ts's validateProposal -- one malformed entry invalidates
// the whole batch of intents rather than trusting a partial result.
export function validateIntentClassification(raw: unknown): ClassifiedIntent[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.intents) || obj.intents.length === 0) return null;

  const intents: ClassifiedIntent[] = [];
  for (const rawIntent of obj.intents) {
    const intent = validateOneIntent(rawIntent);
    if (!intent) return null;
    intents.push(intent);
  }
  return intents;
}

export async function classifyChatIntent(input: ClassifyChatIntentInput): Promise<ClassifiedIntent[] | null> {
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
      tools: [CLASSIFY_INTENT_TOOL],
      tool_choice: { type: "tool", name: "classify_chat_intent" },
      messages: [{ role: "user", content: buildIntentClassificationPrompt(input) }],
    }),
  });

  if (!response.ok) return null;

  const body = await response.json();
  const toolUse = (body.content ?? []).find((block: { type: string }) => block.type === "tool_use");
  if (!toolUse) return null;

  return validateIntentClassification(toolUse.input);
}
