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
import { perMealTarget } from "@/lib/mealplan/targets";
import { calculateBmr, calculateTdee, calculateMacroTargets, type ActivityLevel, type BiologicalSex, type Goal } from "@/lib/tdee";
import { getMostRecentPlan, type PlanSlotView, type PlanView } from "./data";
import { getPantryItems, type PantryItemView } from "./pantryData";
import { addPantryItem, removePantryItem } from "./pantryActions";
import { swapMeal, generatePlan, recomputeWeeklyActual, loadProfile, type GeneratePlanResult } from "./actions";
import { saveProfile } from "@/app/onboarding/actions";
import { resolveDayReference } from "@/lib/chat/resolveDayReference";
import { classifyChatIntent, type ClassifiedIntent, type ProfileOperation, type QaTopic } from "@/lib/chat/intentClassifier";
import { answerReadOnlyQuestion, MEAL_TYPE_LABELS } from "@/lib/chat/answerReadOnlyQuestion";
import { applyProfileOperations, type ProfileFields } from "@/lib/chat/applyProfileOperations";
import { classifyAffirmativeResponse } from "@/lib/chat/classifyAffirmativeResponse";
import { proposeMealEditViaClaude } from "@/lib/mealplan/mealEditProposer";
import {
  composeMealFromEditDetailed,
  isNoOpEdit,
  describeRejectionForChatUser,
  type MealEditProposal,
  type MealRole,
} from "@/lib/mealplan/aiMealComposition";
import { lookupIngredientMacrosCached } from "@/lib/mealplan/ingredientMacroCache";
import type { DietaryContext } from "@/lib/mealplan/openEndedIngredientSafety";

export type ChatActionTaken =
  | { kind: "swap"; dayIndex: number; mealType: MealType; blocked: boolean }
  | { kind: "meal_edit"; dayIndex: number; mealType: MealType; changeSummary: string }
  | { kind: "meal_edit_rejected"; dayIndex: number; mealType: MealType }
  | { kind: "meal_edit_noop"; dayIndex: number; mealType: MealType }
  | {
      kind: "pending_clamp_suggestion";
      dayIndex: number;
      mealType: MealType;
      proposal: MealEditProposal;
      role: MealRole;
      ingredientName: string;
      suggestedAmountG: number;
    }
  | { kind: "confirm_pending_action" }
  | { kind: "pantry_edit"; operations: Array<{ action: "add" | "remove"; itemName: string }> }
  | { kind: "profile_edit"; regenerated: boolean }
  | { kind: "qa"; topic: QaTopic }
  | { kind: "clarify" }
  | { kind: "refuse" }
  | { kind: "error" };

type PendingClampSuggestion = ChatActionTaken & { kind: "pending_clamp_suggestion" };

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

// Shared by both the fresh edit-proposal path (handleEditMealRecipe) and
// the clamp-confirmation replay path (resolvePendingClamp) -- everything
// after "here is a MealEditProposal" is identical regardless of which one
// produced it. currentComposedIngredientsInGrams is non-null only for an
// AI-composed slot (already grams-based) -- a real recipe's native units
// aren't comparable to an edit's grams the same way, so no-op detection is
// skipped there rather than comparing apples to oranges.
async function applyMealEditResult(
  supabase: SupabaseClient,
  mealPlanId: string,
  dayIndex: number,
  mealType: MealType,
  edit: MealEditProposal,
  dietaryCtx: DietaryContext,
  currentComposedIngredientsInGrams: Array<{ name: string; amountG: number }> | null,
): Promise<IntentHandlerResult> {
  const result = await composeMealFromEditDetailed(edit, dietaryCtx, lookupIngredientMacrosCached);

  if (!result.ok) {
    if (result.reason.kind === "amount_out_of_bounds") {
      const { role, ingredientName, amountG, min, max } = result.reason;
      const suggestedAmountG = amountG > max ? max : min;
      return {
        reply: `${describeRejectionForChatUser(result.reason)} Want me to use ${suggestedAmountG}g instead?`,
        actionTaken: { kind: "pending_clamp_suggestion", dayIndex, mealType, proposal: edit, role, ingredientName, suggestedAmountG },
      };
    }
    return { reply: describeRejectionForChatUser(result.reason), actionTaken: { kind: "meal_edit_rejected", dayIndex, mealType } };
  }

  if (currentComposedIngredientsInGrams && isNoOpEdit(currentComposedIngredientsInGrams, result.meal)) {
    return { reply: "That's already what this meal has.", actionTaken: { kind: "meal_edit_noop", dayIndex, mealType } };
  }

  const meal = result.meal;
  const pricePerServingCents = meal.totalEstimatedCostCents !== null ? Math.round(meal.totalEstimatedCostCents) : null;

  const { data: updatedSlot, error: updateError } = await supabase
    .from("meal_plan_slots")
    .update({
      recipe_id: null,
      // Per the explicit product decision: an edit (of EITHER a real
      // recipe or an already-AI-composed meal) becomes an AI-composed-
      // style meal going forward -- never the unused 'ai_edited' enum
      // value that's sat in the schema's check constraint since 0008.
      recipe_source: "ai_composed",
      recipe_title: meal.dishName,
      image_url: null,
      servings: 1,
      calories: meal.totalCalories,
      protein_g: meal.totalProteinG,
      carbs_g: meal.totalCarbsG,
      fat_g: meal.totalFatG,
      price_per_serving_cents: pricePerServingCents,
      scale_factor: 1,
      // "Composed directly," not a recipe-search tolerance tier -- same
      // convention ranking.ts's composedSnackCandidate/AI-composed
      // candidates already use.
      tolerance_tier: "p10",
      match_label: null,
      ingredients: meal.ingredients.map((i) => ({
        id: i.spoonacularIngredientId,
        name: i.ingredientName,
        amount: i.amountG,
        unit: "g",
        metricAmount: i.amountG,
        metricUnit: "g",
        role: i.role,
      })),
      // Must invalidate -- stale instructions would reference the
      // pre-edit ingredient list.
      ai_recipe_instructions: null,
    })
    .eq("meal_plan_id", mealPlanId)
    .eq("day_index", dayIndex)
    .eq("meal_type", mealType)
    .select("id")
    .single();

  if (updateError || !updatedSlot) {
    return { reply: `I couldn't save that edit: ${updateError?.message ?? "unknown error"}`, actionTaken: { kind: "error" } };
  }

  // Same as swapMeal: a stale add-on sized for the pre-edit meal is worse
  // than none.
  await supabase.from("meal_plan_slot_addons").delete().eq("meal_plan_slot_id", updatedSlot.id);
  const weeklyActual = await recomputeWeeklyActual(supabase, mealPlanId);

  const slot: PlanSlotView = {
    dayIndex,
    mealType,
    recipeId: null,
    recipeTitle: meal.dishName,
    isComposed: true,
    aiComposed: true,
    isUnfilled: false,
    composedIngredients: meal.ingredients.map((i) => ({ name: i.ingredientName, amountG: i.amountG })),
    recipeIngredients: null,
    imageUrl: null,
    servings: 1,
    calories: meal.totalCalories,
    proteinG: meal.totalProteinG,
    carbsG: meal.totalCarbsG,
    fatG: meal.totalFatG,
    pricePerServingCents,
    scaleFactor: 1,
    toleranceTier: "p10",
    matchLabel: null,
    addon: null,
  };

  return {
    reply: edit.changeSummary,
    actionTaken: { kind: "meal_edit", dayIndex, mealType, changeSummary: edit.changeSummary },
    updatedSlot: slot,
    updatedWeeklyActual: weeklyActual,
  };
}

async function handleEditMealRecipe(
  supabase: SupabaseClient,
  userId: string,
  plan: PlanView | null,
  dayIndex: number,
  mealType: MealType,
  editInstruction: string,
): Promise<IntentHandlerResult> {
  if (!plan) return { reply: "You don't have a generated plan yet, so there's nothing to edit.", actionTaken: { kind: "error" } };
  if (mealType === "snack1" || mealType === "snack2") {
    return { reply: "I can only edit breakfast/lunch/dinner recipes right now, not snacks.", actionTaken: { kind: "error" } };
  }
  const slot = plan.slots.find((s) => s.dayIndex === dayIndex && s.mealType === mealType);
  if (!slot || slot.isUnfilled) {
    return { reply: "I couldn't find that meal in your current plan.", actionTaken: { kind: "error" } };
  }

  const profile = await loadProfile(supabase, userId);
  if (!profile) return { reply: "Complete onboarding before I can edit a meal.", actionTaken: { kind: "error" } };

  const dailyTargets: MacroTargets = {
    calories: profile.daily_calories,
    proteinG: profile.daily_protein_g,
    carbsG: profile.daily_carbs_g,
    fatG: profile.daily_fat_g,
  };
  const target = perMealTarget(dailyTargets, mealType);
  const dietaryCtx: DietaryContext = { dietaryStyles: profile.dietary_styles, allergies: profile.allergies, dislikes: profile.dislikes };

  const currentIngredients = slot.composedIngredients
    ? slot.composedIngredients.map((i) => ({ name: i.name, amount: i.amountG, unit: "g" }))
    : (slot.recipeIngredients ?? []).map((i) => ({ name: i.name, amount: i.amount, unit: i.unit }));

  const edit = await proposeMealEditViaClaude({
    currentDishName: slot.recipeTitle,
    currentIngredients,
    userInstruction: editInstruction,
    mealType,
    target,
    dietaryStyles: dietaryCtx.dietaryStyles,
    allergies: dietaryCtx.allergies,
    dislikes: dietaryCtx.dislikes,
  });
  if (!edit) return { reply: "I couldn't process that edit right now -- try rephrasing?", actionTaken: { kind: "error" } };

  const currentComposedInGrams = slot.composedIngredients ? slot.composedIngredients.map((i) => ({ name: i.name, amountG: i.amountG })) : null;
  return applyMealEditResult(supabase, plan.id, dayIndex, mealType, edit, dietaryCtx, currentComposedInGrams);
}

// Resolves a pending clamp suggestion -- either from the fast deterministic
// yes/no check or from the classifier's own confirm_pending_action intent.
// Confirming is a pure deterministic replay: the LLM already did its
// judgment work when it produced `proposal`; this just clamps the ONE
// offending ingredient's amount and re-grounds, no second Claude call.
async function resolvePendingClamp(
  supabase: SupabaseClient,
  userId: string,
  mealPlanId: string | undefined,
  pending: PendingClampSuggestion,
  confirmed: boolean,
): Promise<IntentHandlerResult> {
  if (!confirmed) {
    return { reply: "Okay, leaving that meal as-is.", actionTaken: { kind: "confirm_pending_action" } };
  }
  if (!mealPlanId) {
    return { reply: "I couldn't find that meal plan anymore -- try the edit again?", actionTaken: { kind: "error" } };
  }

  const profile = await loadProfile(supabase, userId);
  const dietaryCtx: DietaryContext = profile
    ? { dietaryStyles: profile.dietary_styles, allergies: profile.allergies, dislikes: profile.dislikes }
    : { dietaryStyles: [], allergies: [], dislikes: [] };

  // changeSummary is deliberately NOT reused from pending.proposal -- that
  // text describes the ORIGINAL (rejected) amount, which would now
  // misdescribe what's actually being applied. Built fresh here since the
  // clamp itself is fully known/deterministic at this point.
  const clampedEdit: MealEditProposal = {
    ...pending.proposal,
    ingredients: pending.proposal.ingredients.map((i) =>
      i.name === pending.ingredientName && i.role === pending.role ? { ...i, amountG: pending.suggestedAmountG } : i,
    ),
    changeSummary: `Used ${pending.suggestedAmountG}g of ${pending.ingredientName} instead of the amount you asked for -- everything else stays the same.`,
  };

  return applyMealEditResult(supabase, mealPlanId, pending.dayIndex, pending.mealType, clampedEdit, dietaryCtx, null);
}

function describePendingSuggestion(pending: PendingClampSuggestion): string {
  return `use ${pending.suggestedAmountG}g of ${pending.ingredientName} instead, for ${MEAL_TYPE_LABELS[pending.mealType]} on day ${pending.dayIndex + 1}`;
}

async function dispatchIntent(
  supabase: SupabaseClient,
  userId: string,
  plan: PlanView | null,
  pendingClamp: PendingClampSuggestion | null,
  intent: ClassifiedIntent,
): Promise<IntentHandlerResult> {
  switch (intent.kind) {
    case "swap_meal":
      if (!plan) return { reply: "You don't have a generated plan yet, so there's nothing to swap.", actionTaken: { kind: "error" } };
      return handleSwapMeal(plan.id, intent.dayIndex, intent.mealType);
    case "edit_meal_recipe":
      return handleEditMealRecipe(supabase, userId, plan, intent.dayIndex, intent.mealType, intent.editInstruction);
    case "edit_pantry":
      return handleEditPantry(supabase, userId, intent.operations);
    case "edit_profile":
      return handleEditProfile(supabase, userId, intent.operations);
    case "read_only_qa":
      return handleReadOnlyQa(intent.qaTopic, intent.dayIndex, intent.mealType, plan);
    case "confirm_pending_action":
      if (!pendingClamp) return { reply: "There's nothing pending for me to confirm.", actionTaken: { kind: "confirm_pending_action" } };
      return resolvePendingClamp(supabase, userId, plan?.id, pendingClamp, intent.confirmed);
    case "clarify":
      return { reply: intent.message, actionTaken: { kind: "clarify" } };
    case "refuse":
      return { reply: intent.message, actionTaken: { kind: "refuse" } };
  }
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function loadPendingClamp(supabase: SupabaseClient, userId: string): Promise<PendingClampSuggestion | null> {
  const { data } = await supabase
    .from("chat_messages")
    .select("action_taken")
    .eq("user_id", userId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1);
  const lastActionTaken = data?.[0]?.action_taken as ChatActionTaken[] | null;
  const found = lastActionTaken?.find((a) => a.kind === "pending_clamp_suggestion");
  return (found as PendingClampSuggestion | undefined) ?? null;
}

export async function sendChatMessage(input: SendChatMessageInput): Promise<SendChatMessageResult> {
  const message = input.message.trim();
  if (!message) return emptyResult("Say something and I'll take a look.");

  const supabase = await createClient();
  const user = await getCurrentUser();
  if (!user) return emptyResult("No active session — refresh the page and try again.");

  const plan = await getMostRecentPlan(supabase, user.id);
  const pendingClamp = await loadPendingClamp(supabase, user.id);

  // Fast path: a plain yes/no reply to a pending clamp offer never needs
  // the full classifier -- cheap, deterministic, and the confirmation
  // itself is a pure replay (no second Claude call for the edit either).
  const fastAffirmative = pendingClamp ? classifyAffirmativeResponse(message) : null;

  let result: SendChatMessageResult;
  if (pendingClamp && fastAffirmative !== null) {
    const handled = await resolvePendingClamp(supabase, user.id, plan?.id, pendingClamp, fastAffirmative);
    result = {
      reply: handled.reply,
      actionsTaken: [handled.actionTaken],
      updatedSlot: handled.updatedSlot ?? null,
      updatedWeeklyActual: handled.updatedWeeklyActual ?? null,
      updatedPantryItems: null,
      updatedPlan: null,
      blocked: false,
      error: null,
    };
  } else {
    const dayRef = resolveDayReference(message);
    const intents = await classifyChatIntent({
      message,
      resolvedDayIndex: dayRef?.dayIndex ?? null,
      resolvedMatchedPhrase: dayRef?.matchedPhrase ?? null,
      todayWeekdayName: WEEKDAY_NAMES[new Date().getDay()],
      pendingSuggestion: pendingClamp ? describePendingSuggestion(pendingClamp) : null,
    });

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
        const handled = await dispatchIntent(supabase, user.id, updatedPlan ?? plan, pendingClamp, intent);
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
  }

  await supabase.from("chat_messages").insert([
    { user_id: user.id, role: "user", content: message, action_taken: null },
    { user_id: user.id, role: "assistant", content: result.reply, action_taken: result.actionsTaken },
  ]);

  return result;
}
