"use server";

// Conversational plan assistant (F11) -- the orchestrating server action.
// Deliberately a single forced-choice classifier + deterministic router,
// not an open multi-tool agentic loop -- see the plan doc for why. Every
// mutation this dispatches to is an EXISTING action (swapMeal,
// addPantryItem/removePantryItem, saveProfile+generatePlan); this file
// never invents a new write path, matching F11's own PRD line: "chat is a
// second interface onto existing state changes."

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/identity";
import type { MacroTargets, MealType } from "@/lib/mealplan/targets";
import { calculateBmr, calculateTdee, calculateMacroTargets, type ActivityLevel, type BiologicalSex, type Goal } from "@/lib/tdee";
import { getMostRecentPlan, type PlanSlotView, type PlanView } from "./data";
import { getPantryItems, type PantryItemView } from "./pantryData";
import { addPantryItem, removePantryItem } from "./pantryActions";
import { swapMeal, generatePlan, type GeneratePlanResult } from "./actions";
import { saveProfile } from "@/app/onboarding/actions";
import { resolveDayReference } from "@/lib/chat/resolveDayReference";
import { classifyChatIntent, type ClassifiedIntent, type ProfileOperation, type QaTopic } from "@/lib/chat/intentClassifier";
import { answerReadOnlyQuestion, MEAL_TYPE_LABELS } from "@/lib/chat/answerReadOnlyQuestion";
import { applyProfileOperations, type ProfileFields } from "@/lib/chat/applyProfileOperations";

export type ChatActionTaken =
  | { kind: "swap"; dayIndex: number; mealType: MealType; blocked: boolean }
  | { kind: "pantry_edit"; operations: Array<{ action: "add" | "remove"; itemName: string }> }
  | { kind: "profile_edit"; regenerated: boolean }
  | { kind: "qa"; topic: QaTopic }
  | { kind: "clarify" }
  | { kind: "refuse" }
  | { kind: "error" };

export interface SendChatMessageInput {
  message: string;
}

export interface SendChatMessageResult {
  reply: string;
  actionsTaken: ChatActionTaken[];
  updatedSlot: PlanSlotView | null;
  updatedWeeklyActual: MacroTargets | null;
  updatedPantryItems: PantryItemView[] | null;
  updatedPlan: PlanView | null;
  blocked: boolean;
  error: string | null;
}

function emptyResult(error: string): SendChatMessageResult {
  return {
    reply: error,
    actionsTaken: [{ kind: "error" }],
    updatedSlot: null,
    updatedWeeklyActual: null,
    updatedPantryItems: null,
    updatedPlan: null,
    blocked: false,
    error,
  };
}

interface WideProfileRow {
  weight_kg: number;
  height_cm: number;
  age: number;
  biological_sex: BiologicalSex;
  activity_level: ActivityLevel;
  goal: Goal;
  daily_calories: number;
  daily_protein_g: number;
  daily_carbs_g: number;
  daily_fat_g: number;
  dietary_styles: string[];
  allergies: string[];
  dislikes: string[];
  weekly_budget_usd: number | null;
  zip_code: string | null;
}

// Wider than actions.ts's own loadProfile -- an edit_profile intent must
// round-trip saveProfile()'s FULL input (weight/height/age/activity/goal/
// sex too, not just macros/diet), or it would silently wipe onboarding
// fields on every chat-driven save. Not exported/shared with loadProfile
// since this column list is correctness-sensitive, not stylistic
// boilerplate -- see actions.ts's loadProfile comment for the same call.
async function loadWideProfile(supabase: SupabaseClient, userId: string): Promise<WideProfileRow | null> {
  const { data } = await supabase
    .from("profiles")
    .select(
      "weight_kg, height_cm, age, biological_sex, activity_level, goal, daily_calories, daily_protein_g, daily_carbs_g, daily_fat_g, dietary_styles, allergies, dislikes, weekly_budget_usd, zip_code",
    )
    .eq("id", userId)
    .maybeSingle();
  return data;
}

function findPantryItemByName(items: PantryItemView[], name: string): PantryItemView | null {
  const normalized = name.trim().toLowerCase();
  const exact = items.find((i) => i.name.toLowerCase() === normalized);
  if (exact) return exact;
  return items.find((i) => i.name.toLowerCase().includes(normalized) || normalized.includes(i.name.toLowerCase())) ?? null;
}

interface IntentHandlerResult {
  reply: string;
  actionTaken: ChatActionTaken;
  blocked?: boolean;
  updatedSlot?: PlanSlotView | null;
  updatedWeeklyActual?: MacroTargets | null;
  updatedPantryItems?: PantryItemView[] | null;
  updatedPlan?: PlanView | null;
}

async function handleSwapMeal(mealPlanId: string, dayIndex: number, mealType: MealType): Promise<IntentHandlerResult> {
  const result = await swapMeal({ mealPlanId, dayIndex, mealType });
  const label = `${MEAL_TYPE_LABELS[mealType]} on day ${dayIndex + 1}`;
  if (result.error) return { reply: result.error, actionTaken: { kind: "error" } };
  if (result.blocked) {
    return {
      reply: result.blockingHint ?? `I couldn't find a substitute for ${label}.`,
      actionTaken: { kind: "swap", dayIndex, mealType, blocked: true },
      blocked: true,
    };
  }
  return {
    reply: `Swapped ${label} for "${result.slot?.recipeTitle}".`,
    actionTaken: { kind: "swap", dayIndex, mealType, blocked: false },
    updatedSlot: result.slot,
    updatedWeeklyActual: result.weeklyActual,
  };
}

async function handleEditPantry(
  supabase: SupabaseClient,
  userId: string,
  operations: Array<{ action: "add" | "remove"; itemName: string; quantityText: string | null }>,
): Promise<IntentHandlerResult> {
  const messages: string[] = [];
  let items = await getPantryItems(supabase, userId);

  for (const op of operations) {
    if (op.action === "add") {
      const result = await addPantryItem({ name: op.itemName, quantityText: op.quantityText, amount: null, unit: null });
      messages.push(result.error ? `Couldn't add ${op.itemName}: ${result.error}` : `Added ${op.itemName}${op.quantityText ? ` (${op.quantityText})` : ""}.`);
    } else {
      const match = findPantryItemByName(items, op.itemName);
      if (!match) {
        messages.push(`I don't see "${op.itemName}" in your pantry.`);
        continue;
      }
      const result = await removePantryItem(match.id);
      messages.push(result.error ? `Couldn't remove ${op.itemName}: ${result.error}` : `Removed ${op.itemName}.`);
    }
    items = await getPantryItems(supabase, userId);
  }

  return {
    reply: messages.join(" "),
    actionTaken: { kind: "pantry_edit", operations: operations.map((o) => ({ action: o.action, itemName: o.itemName })) },
    updatedPantryItems: items,
  };
}

function toProfileFields(row: WideProfileRow): ProfileFields {
  return {
    weightKg: row.weight_kg,
    heightCm: row.height_cm,
    age: row.age,
    biologicalSex: row.biological_sex,
    activityLevel: row.activity_level,
    goal: row.goal,
    dietaryStyles: row.dietary_styles,
    allergies: row.allergies,
    dislikes: row.dislikes,
  };
}

async function handleEditProfile(supabase: SupabaseClient, userId: string, operations: ProfileOperation[]): Promise<IntentHandlerResult> {
  const row = await loadWideProfile(supabase, userId);
  if (!row) return { reply: "Complete onboarding before I can change your profile.", actionTaken: { kind: "error" } };

  const result = applyProfileOperations(toProfileFields(row), operations);
  if (result.error) return { reply: result.error, actionTaken: { kind: "refuse" } };

  const macros = result.scalarsChanged
    ? calculateMacroTargets(
        calculateTdee(
          calculateBmr({
            weightKg: result.fields.weightKg,
            heightCm: result.fields.heightCm,
            age: result.fields.age,
            biologicalSex: result.fields.biologicalSex,
          }),
          result.fields.activityLevel,
        ),
        result.fields.weightKg,
        result.fields.goal,
      )
    : { dailyCalories: row.daily_calories, dailyProteinG: row.daily_protein_g, dailyCarbsG: row.daily_carbs_g, dailyFatG: row.daily_fat_g };

  const saveResult = await saveProfile({
    weightKg: result.fields.weightKg,
    heightCm: result.fields.heightCm,
    age: result.fields.age,
    biologicalSex: result.fields.biologicalSex,
    activityLevel: result.fields.activityLevel,
    goal: result.fields.goal,
    dailyCalories: macros.dailyCalories,
    dailyProteinG: macros.dailyProteinG,
    dailyCarbsG: macros.dailyCarbsG,
    dailyFatG: macros.dailyFatG,
    dietaryStyles: result.fields.dietaryStyles,
    allergies: result.fields.allergies,
    dislikes: result.fields.dislikes,
    weeklyBudgetUsd: row.weekly_budget_usd, // untouched -- budget editing is out of scope for chat
    zipCode: row.zip_code, // untouched
  });

  if (saveResult.error) return { reply: `I couldn't save that: ${saveResult.error}`, actionTaken: { kind: "error" } };

  // Chat-driven profile edits always regenerate -- unlike onboarding's
  // optional checkbox, leaving a now-noncompliant plan visible after a
  // constraint change (e.g. a new allergy) would be worse than the wait.
  const genResult: GeneratePlanResult = await generatePlan();
  if (genResult.error) {
    return {
      reply: `Saved your profile, but I couldn't regenerate your plan: ${genResult.error} Your existing plan may no longer match.`,
      actionTaken: { kind: "profile_edit", regenerated: false },
    };
  }
  if (genResult.usingCachedFallback) {
    return {
      reply: "Saved your profile -- live generation is temporarily unavailable, so your plan still shows last week's meals for now.",
      actionTaken: { kind: "profile_edit", regenerated: false },
      updatedPlan: genResult.plan,
    };
  }
  return {
    reply: "Updated your profile and regenerated your plan to match.",
    actionTaken: { kind: "profile_edit", regenerated: true },
    updatedPlan: genResult.plan,
  };
}

function handleReadOnlyQa(topic: QaTopic, dayIndex: number | null, mealType: MealType | null, plan: PlanView | null): IntentHandlerResult {
  return { reply: answerReadOnlyQuestion(topic, dayIndex, mealType, plan), actionTaken: { kind: "qa", topic } };
}

async function dispatchIntent(
  supabase: SupabaseClient,
  userId: string,
  plan: PlanView | null,
  intent: ClassifiedIntent,
): Promise<IntentHandlerResult> {
  switch (intent.kind) {
    case "swap_meal":
      if (!plan) return { reply: "You don't have a generated plan yet, so there's nothing to swap.", actionTaken: { kind: "error" } };
      return handleSwapMeal(plan.id, intent.dayIndex, intent.mealType);
    case "edit_pantry":
      return handleEditPantry(supabase, userId, intent.operations);
    case "edit_profile":
      return handleEditProfile(supabase, userId, intent.operations);
    case "read_only_qa":
      return handleReadOnlyQa(intent.qaTopic, intent.dayIndex, intent.mealType, plan);
    case "clarify":
      return { reply: intent.message, actionTaken: { kind: "clarify" } };
    case "refuse":
      return { reply: intent.message, actionTaken: { kind: "refuse" } };
  }
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function sendChatMessage(input: SendChatMessageInput): Promise<SendChatMessageResult> {
  const message = input.message.trim();
  if (!message) return emptyResult("Say something and I'll take a look.");

  const supabase = await createClient();
  const user = await getCurrentUser();
  if (!user) return emptyResult("No active session — refresh the page and try again.");

  const plan = await getMostRecentPlan(supabase, user.id);

  const dayRef = resolveDayReference(message);
  const intents = await classifyChatIntent({
    message,
    resolvedDayIndex: dayRef?.dayIndex ?? null,
    resolvedMatchedPhrase: dayRef?.matchedPhrase ?? null,
    todayWeekdayName: WEEKDAY_NAMES[new Date().getDay()],
  });

  let result: SendChatMessageResult;
  if (!intents) {
    result = emptyResult("Sorry, I couldn't understand that -- could you try rephrasing?");
  } else {
    const replies: string[] = [];
    const actionsTaken: ChatActionTaken[] = [];
    let updatedSlot: PlanSlotView | null = null;
    let updatedWeeklyActual: MacroTargets | null = null;
    let updatedPantryItems: PantryItemView[] | null = null;
    let updatedPlan: PlanView | null = null;
    let blocked = false;

    for (const intent of intents) {
      const handled = await dispatchIntent(supabase, user.id, updatedPlan ?? plan, intent);
      replies.push(handled.reply);
      actionsTaken.push(handled.actionTaken);
      if (handled.blocked) blocked = true;
      if (handled.updatedSlot !== undefined) updatedSlot = handled.updatedSlot;
      if (handled.updatedWeeklyActual !== undefined) updatedWeeklyActual = handled.updatedWeeklyActual;
      if (handled.updatedPantryItems !== undefined) updatedPantryItems = handled.updatedPantryItems;
      if (handled.updatedPlan !== undefined) updatedPlan = handled.updatedPlan;
    }

    result = {
      reply: replies.join(" "),
      actionsTaken,
      updatedSlot,
      updatedWeeklyActual,
      updatedPantryItems,
      updatedPlan,
      blocked,
      error: null,
    };
  }

  await supabase.from("chat_messages").insert([
    { user_id: user.id, role: "user", content: message, action_taken: null },
    { user_id: user.id, role: "assistant", content: result.reply, action_taken: result.actionsTaken },
  ]);

  return result;
}
