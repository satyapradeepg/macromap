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

export type QaTopic = "remaining_weekly_macros" | "specific_meal_details" | "today_summary" | "unsupported";

export type ProfileOperation =
  | { field: "dietaryStyles" | "allergies" | "dislikes"; action: "add" | "remove"; value: string }
  | { field: "weightKg" | "heightCm" | "age" | "activityLevel" | "goal" | "biologicalSex"; action: "set"; value: string };

export type ClassifiedIntent =
  | { kind: "swap_meal"; dayIndex: number; mealType: MealType }
  | { kind: "edit_pantry"; operations: Array<{ action: "add" | "remove"; itemName: string; quantityText: string | null }> }
  | { kind: "edit_profile"; operations: ProfileOperation[] }
  | { kind: "read_only_qa"; qaTopic: QaTopic; dayIndex: number | null; mealType: MealType | null }
  | { kind: "clarify"; message: string }
  | { kind: "refuse"; message: string };

export interface ClassifyChatIntentInput {
  message: string;
  resolvedDayIndex: number | null;
  resolvedMatchedPhrase: string | null;
  todayWeekdayName: string;
}

const MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner", "snack1", "snack2"];
const PROFILE_LIST_FIELDS = ["dietaryStyles", "allergies", "dislikes"] as const;
const PROFILE_SET_FIELDS = ["weightKg", "heightCm", "age", "activityLevel", "goal", "biologicalSex"] as const;
const QA_TOPICS: QaTopic[] = ["remaining_weekly_macros", "specific_meal_details", "today_summary", "unsupported"];

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
              enum: ["swap_meal", "edit_pantry", "edit_profile", "read_only_qa", "clarify", "refuse"],
            },
            dayIndex: {
              type: "number",
              description:
                "For swap_meal (required) or read_only_qa about a specific meal: which day, 0=today through 6. Prefer the resolved day hint given in the prompt when the message's day reference matches it.",
            },
            mealType: {
              type: "string",
              enum: MEAL_TYPES,
              description: "For swap_meal (required) or read_only_qa about a specific meal.",
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
                "For read_only_qa only. Use 'unsupported' for anything not covered by the other three (including any question about budget/grocery cost, which this assistant deliberately does not answer).",
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
  const { message, resolvedDayIndex, resolvedMatchedPhrase, todayWeekdayName } = input;
  return `A user of a meal-planning app sent this chat message: "${message}"

Today is ${todayWeekdayName}. This app's plan is a rolling 7-day window where day 0 is always today, day 1 is tomorrow, and so on through day 6 -- there is no fixed Monday-Sunday week.
${resolvedDayIndex !== null ? `A deterministic parser already resolved a day reference in this message ("${resolvedMatchedPhrase}") to dayIndex ${resolvedDayIndex} -- use this exact value for any intent that needs a day, don't re-derive it yourself.` : "No day reference was deterministically resolved from this message -- if an intent needs a specific day and you genuinely can't tell which one, use 'clarify' instead of guessing."}

Classify this message into one or more of these intents:
- swap_meal: the user wants a specific meal replaced with something different. Needs dayIndex and mealType.
- edit_pantry: the user is telling you what they have or don't have on hand (e.g. "I have chicken and rice", "I used up the eggs"). Needs pantryOperations.
- edit_profile: the user wants to change something about their diet, allergies, dislikes, weight, height, age, activity level, or goal. Needs profileOperations. Diet/allergy/dislike changes are add/remove against their existing list (e.g. "I'm allergic to peanuts now" = add; "I'm not vegan anymore" = remove), never a full replacement. Weight/height/age/activity/goal/sex changes are a set (a new value).
- read_only_qa: the user is asking a question, not asking for a change. Needs qaTopic ('remaining_weekly_macros' for "how many calories/protein/etc do I have left this week", 'specific_meal_details' for "what's in tonight's dinner" -- also set dayIndex/mealType for this one, 'today_summary' for a general "what's today look like", 'unsupported' for anything else including budget/cost questions).
- clarify: you genuinely cannot tell what the user wants well enough to act (which day, which meal, what change) -- ask a short, specific question back in the message field. Never guess and execute when this is the better fit.
- refuse: the request is clearly outside what this assistant can do (e.g. asking to change the budget, which is intentionally not exposed here) -- explain why in the message field. This is different from a hard-constraint safety refusal, which happens deterministically downstream, not here -- don't try to pre-judge allergy/diet conflicts yourself; classify the request normally (e.g. still emit edit_pantry or swap_meal) and let the app's own safety checks catch a real conflict.

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
    case "edit_pantry": {
      if (!Array.isArray(obj.pantryOperations) || obj.pantryOperations.length === 0) return null;
      const operations: Array<{ action: "add" | "remove"; itemName: string; quantityText: string | null }> = [];
      for (const op of obj.pantryOperations) {
        if (typeof op !== "object" || op === null) return null;
        const o = op as Record<string, unknown>;
        if (o.action !== "add" && o.action !== "remove") return null;
        if (typeof o.itemName !== "string" || !o.itemName.trim()) return null;
        operations.push({
          action: o.action,
          itemName: o.itemName,
          quantityText: typeof o.quantityText === "string" && o.quantityText.trim() ? o.quantityText : null,
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
