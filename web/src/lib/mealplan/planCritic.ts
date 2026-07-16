// Calls Claude to review a just-generated week and flag specific slots
// worth a second look — the one piece of judgment in this file; the
// actual accept/reject decision on any flagged slot happens in
// planRepair.ts, deterministically, using real macro data. Same forced
// tool-call pattern as mealProposer.ts, for the same reason: reliable
// structured output instead of parsing free-text JSON.
//
// Why this needs an LLM at all, not more deterministic logic: the
// per-slot pipeline (cascade, reconciliation, AI composition) never sees
// the whole week at once, so it structurally can't notice "this exact
// recipe is showing up 4 times" or "this one meal is a noticeably worse
// fit than everything around it" -- that requires holding all 35 slots
// in view simultaneously and comparing them, which is exactly the kind
// of holistic judgment call this project's own bar for introducing an
// LLM has consistently required (see aiMealComposition.ts).
//
// diet_violation (added July 16 2026, following the string-matching
// audit): a second, coarser-grained safety net on top of the deterministic
// keyword gates (ingredientSafety.ts/openEndedIngredientSafety.ts), which
// stay the primary defense and run on every candidate during generation.
// This catches whatever a finite keyword list structurally can't --
// foreign-language ingredient names, obscure hidden animal products,
// anything the deterministic lists don't yet know about. Deliberately
// biased toward flagging on uncertainty (see the prompt below): a false
// alarm here just costs an extra swap attempt in planRepair.ts, but a
// missed real violation is the exact failure mode this exists to prevent.
//
// Model id: per ai-agents.md's standing note, confirm against the latest
// available Sonnet-tier model at deploy time rather than trusting this
// string indefinitely.
const MODEL = "claude-sonnet-5";

export interface PlanSlotSummary {
  dayIndex: number;
  mealType: string;
  title: string;
  proteinG: number;
  caloriesKcal: number;
  carbsG: number;
  fatG: number;
  isComposed: boolean;
}

export interface CritiquePlanInput {
  slots: PlanSlotSummary[];
  weeklyTarget: { proteinG: number; calories: number; carbsG: number; fatG: number };
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
}

export interface FlaggedSlot {
  dayIndex: number;
  mealType: string;
  reason: "repetitive" | "macro_miss" | "diet_violation" | "other";
  note: string;
}

export interface PlanCritique {
  flaggedSlots: FlaggedSlot[];
  overallAssessment: string;
}

const CRITIQUE_PLAN_TOOL = {
  name: "critique_plan",
  description: "Flag specific meal slots in a week-long plan that would benefit from being regenerated, and give a short overall assessment.",
  input_schema: {
    type: "object",
    properties: {
      overallAssessment: { type: "string", description: "1-2 sentence honest assessment of the week's variety and macro fit." },
      flaggedSlots: {
        type: "array",
        description: "Only include slots genuinely worth reconsidering -- don't flag something just to have something to say.",
        items: {
          type: "object",
          properties: {
            dayIndex: { type: "number", description: "0-6, Monday=0" },
            mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack1", "snack2"] },
            reason: { type: "string", enum: ["repetitive", "macro_miss", "diet_violation", "other"] },
            note: { type: "string", description: "One sentence on why this slot was flagged." },
          },
          required: ["dayIndex", "mealType", "reason", "note"],
        },
      },
    },
    required: ["overallAssessment", "flaggedSlots"],
  },
};

function buildPrompt(input: CritiquePlanInput): string {
  const rows = input.slots
    .map(
      (s) =>
        `Day ${s.dayIndex} ${s.mealType}: "${s.title}"${s.isComposed ? " (composed)" : ""} -- ${Math.round(s.caloriesKcal)} cal / ${Math.round(s.proteinG)}g protein / ${Math.round(s.carbsG)}g carbs / ${Math.round(s.fatG)}g fat`,
    )
    .join("\n");

  return `Review this week's generated meal plan. Look across ALL 7 days at once -- your job is specifically to catch things a slot-by-slot check can't: the same dish appearing too many times, or one meal that's a noticeably worse macro fit than the rest of the week even if it technically passed.

Weekly target: ${Math.round(input.weeklyTarget.calories)} cal / ${Math.round(input.weeklyTarget.proteinG)}g protein / ${Math.round(input.weeklyTarget.carbsG)}g carbs / ${Math.round(input.weeklyTarget.fatG)}g fat
Dietary style: ${input.dietaryStyles.length ? input.dietaryStyles.join(", ") : "none"}
Allergies: ${input.allergies.length ? input.allergies.join(", ") : "none"}
Dislikes: ${input.dislikes.length ? input.dislikes.join(", ") : "none"}

${rows}

Flag only slots genuinely worth regenerating -- a dish appearing twice in a week of 35 meals isn't automatically a problem, but 4+ times likely is. Don't flag composed snacks for repetition; the fixed ingredient pool means some repetition there is expected and already accounted for elsewhere. Focus repetition flags on real recipes (breakfast/lunch/dinner).

Also check every meal against the dietary style, allergies, and dislikes listed above. Flag any meal that violates one of them as diet_violation -- for example, a hidden animal product, a non-obvious allergen, or a foreign-language ingredient name that a simple keyword scan could plausibly miss (e.g. "nam pla," "dashi," "suet"). Be specific in the note about which ingredient and which restriction it violates. Don't flag a meal you're not reasonably confident about -- false alarms cost a swap, but so does silence, so when genuinely uncertain about a real animal product or allergen, flag it.`;
}

export async function critiquePlan(input: CritiquePlanInput): Promise<PlanCritique | null> {
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
      max_tokens: 1536,
      tools: [CRITIQUE_PLAN_TOOL],
      tool_choice: { type: "tool", name: "critique_plan" },
      messages: [{ role: "user", content: buildPrompt(input) }],
    }),
  });

  if (!response.ok) return null;

  const body = await response.json();
  const toolUse = (body.content ?? []).find((block: { type: string }) => block.type === "tool_use");
  if (!toolUse) return null;

  return validateCritique(toolUse.input);
}

const VALID_REASONS = ["repetitive", "macro_miss", "diet_violation", "other"];
const VALID_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack1", "snack2"];

// Never trusts the LLM's JSON shape blindly -- malformed output returns
// null, same "never fake progress" discipline as mealProposer.ts's
// validateProposal. The caller treats null as "no critique available,"
// not a crash.
export function validateCritique(raw: unknown): PlanCritique | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.overallAssessment !== "string") return null;
  if (!Array.isArray(obj.flaggedSlots)) return null;

  const flaggedSlots: FlaggedSlot[] = [];
  for (const item of obj.flaggedSlots) {
    if (typeof item !== "object" || item === null) return null;
    const i = item as Record<string, unknown>;
    // Number.isInteger, not just typeof/range comparisons -- found July 16
    // 2026 (comprehensive engine test): dayIndex < 0 and dayIndex > 6 are
    // BOTH false for NaN (every NaN comparison is false), so a malformed
    // tool-call response with dayIndex: NaN used to sail through this
    // validator whose entire job is "never trust the LLM's shape
    // blindly." Number.isInteger(NaN) is false, closing the gap and
    // rejecting non-integer values (e.g. 2.5) for free.
    if (!Number.isInteger(i.dayIndex) || (i.dayIndex as number) < 0 || (i.dayIndex as number) > 6) return null;
    if (typeof i.mealType !== "string" || !VALID_MEAL_TYPES.includes(i.mealType)) return null;
    if (typeof i.reason !== "string" || !VALID_REASONS.includes(i.reason)) return null;
    if (typeof i.note !== "string") return null;
    flaggedSlots.push({
      dayIndex: i.dayIndex as number,
      mealType: i.mealType,
      reason: i.reason as FlaggedSlot["reason"],
      note: i.note,
    });
  }

  return { overallAssessment: obj.overallAssessment, flaggedSlots };
}
