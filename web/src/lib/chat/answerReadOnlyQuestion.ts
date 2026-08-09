// Deterministic dispatcher for the assistant's read-only Q&A intent (F11).
// No Claude call for the numeric content at all -- the actual answer is
// always formatted from already-loaded PlanView/plan data, matching this
// codebase's universal grounding rule (every macro number traces back to
// real stored data, never LLM-estimated) generalized to chat.

import type { PlanView, PlanSlotView } from "@/app/plan/data";
import type { QaTopic } from "./intentClassifier";
import type { MealType } from "@/lib/mealplan/targets";
import type { PantryItemView } from "@/app/plan/pantryData";

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack1: "Snack 1",
  snack2: "Snack 2",
};

const NO_PLAN_MESSAGE = "You don't have a generated plan yet, so I can't answer that.";

function round(n: number): number {
  return Math.round(n);
}

function findSlot(plan: PlanView, dayIndex: number, mealType: MealType): PlanSlotView | null {
  return plan.slots.find((s) => s.dayIndex === dayIndex && s.mealType === mealType) ?? null;
}

function describeSlot(slot: PlanSlotView): string {
  if (slot.isUnfilled) {
    return `${MEAL_TYPE_LABELS[slot.mealType]} on day ${slot.dayIndex + 1} doesn't have a meal filled in yet.`;
  }
  const ingredientNames = slot.composedIngredients
    ? slot.composedIngredients.map((i) => i.name)
    : (slot.recipeIngredients ?? []).map((i) => i.name);
  const ingredientLine = ingredientNames.length ? ` Ingredients: ${ingredientNames.join(", ")}.` : "";
  return `${MEAL_TYPE_LABELS[slot.mealType]} on day ${slot.dayIndex + 1} is "${slot.recipeTitle}" (${round(slot.calories)} cal, ${round(slot.proteinG)}g protein, ${round(slot.carbsG)}g carbs, ${round(slot.fatG)}g fat).${ingredientLine}`;
}

function answerRemainingWeeklyMacros(plan: PlanView): string {
  const remaining = {
    calories: plan.weeklyTarget.calories - plan.weeklyActual.calories,
    proteinG: plan.weeklyTarget.proteinG - plan.weeklyActual.proteinG,
    carbsG: plan.weeklyTarget.carbsG - plan.weeklyActual.carbsG,
    fatG: plan.weeklyTarget.fatG - plan.weeklyActual.fatG,
  };
  return `So far this week's plan totals ${round(plan.weeklyActual.calories)} of your ${round(plan.weeklyTarget.calories)} calorie target, ${round(plan.weeklyActual.proteinG)}g of ${round(plan.weeklyTarget.proteinG)}g protein, ${round(plan.weeklyActual.carbsG)}g of ${round(plan.weeklyTarget.carbsG)}g carbs, and ${round(plan.weeklyActual.fatG)}g of ${round(plan.weeklyTarget.fatG)}g fat -- leaving ${round(remaining.calories)} calories, ${round(remaining.proteinG)}g protein, ${round(remaining.carbsG)}g carbs, and ${round(remaining.fatG)}g fat.`;
}

function answerSpecificMealDetails(plan: PlanView, dayIndex: number | null, mealType: MealType | null): string {
  if (dayIndex === null || mealType === null) {
    return "Which meal did you want to know about -- which day and breakfast/lunch/dinner/snack?";
  }
  const slot = findSlot(plan, dayIndex, mealType);
  if (!slot) return "I couldn't find that meal in your current plan.";
  return describeSlot(slot);
}

function answerTodaySummary(plan: PlanView): string {
  const todaySlots = plan.slots.filter((s) => s.dayIndex === 0 && !s.isUnfilled);
  if (todaySlots.length === 0) return "I don't see any meals filled in for today.";
  const lines = todaySlots.map((s) => `${MEAL_TYPE_LABELS[s.mealType]}: ${s.recipeTitle} (${round(s.calories)} cal)`);
  const totalCalories = todaySlots.reduce((sum, s) => sum + s.calories, 0);
  return `Today: ${lines.join("; ")}. That's ${round(totalCalories)} calories so far today.`;
}

// Added 2026-08-09 alongside the pantry_contents topic itself -- pantry
// items aren't part of PlanView, so this takes its own parameter rather
// than reading it from plan like every other case here.
function answerPantryContents(items: PantryItemView[]): string {
  if (items.length === 0) return "Your pantry is empty right now -- tell me what you have and I'll log it.";
  const lines = items.map((i) => (i.quantityText ? `${i.name} (${i.quantityText})` : i.name));
  return `Your pantry has: ${lines.join(", ")}.`;
}

// Live-confirmed 2026-08-09 (F11 chat-driven testing against production):
// this message used to hardcode "budget/cost tracking" as THE named
// example of what's unsupported, regardless of what was actually asked --
// reproduced identically for a pantry question (before pantry_contents
// existed as its own topic) and for a genuinely unrelated one ("what's
// the weather like today?"), both misleadingly implied the question had
// been mistaken for a budget question. Lists the real supported topics
// instead of guessing at what was actually asked.
const UNSUPPORTED_MESSAGE =
  "I can answer questions about how many calories/macros you have left this week, what's in a specific meal, a summary of today's plan, or what's in your pantry -- anything else (like budget/cost tracking) isn't something I can answer right now.";

export function answerReadOnlyQuestion(
  topic: QaTopic,
  dayIndex: number | null,
  mealType: MealType | null,
  plan: PlanView | null,
  pantryItems: PantryItemView[] | null = null,
): string {
  if (topic === "pantry_contents") return answerPantryContents(pantryItems ?? []);
  if (topic === "unsupported") return UNSUPPORTED_MESSAGE;
  if (!plan) return NO_PLAN_MESSAGE;

  switch (topic) {
    case "remaining_weekly_macros":
      return answerRemainingWeeklyMacros(plan);
    case "specific_meal_details":
      return answerSpecificMealDetails(plan, dayIndex, mealType);
    case "today_summary":
      return answerTodaySummary(plan);
  }
}
