"use client";

import { useState } from "react";
import {
  MEAL_TYPES,
  DAYS_PER_WEEK,
  structuralCalorieFloorExceedsTarget,
  STRUCTURAL_CALORIE_FLOOR_TOTAL,
  type MealType,
  type MacroTargets,
} from "@/lib/mealplan/targets";
import { toleranceBand, isWithinBand } from "@/lib/mealplan/reconciliation";
import { unsupportedDietaryStyles } from "@/lib/mealplan/dietaryMapping";
import { recipeVideoSearchUrl } from "@/lib/youtube";
import { generatePlan, swapMeal } from "./actions";
import type { BlockedSlotView, PlanSlotView, PlanView } from "./data";
import { PantryPanel } from "./PantryPanel";
import type { PantryItemView } from "./pantryData";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function slotMapKey(dayIndex: number, mealType: MealType): string {
  return `${dayIndex}-${mealType}`;
}

const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "breakfast",
  lunch: "lunch",
  dinner: "dinner",
  snack1: "snack 1",
  snack2: "snack 2",
};

// Reconciliation runs per day server-side (orchestrate.ts) — this mirrors
// that same ±5% check purely for display, derived from data the plan
// already carries (no separate persisted per-day status). weeklyTarget/7
// is exactly the daily target orchestrate.ts used, since weeklyTarget is
// always dailyTarget x 7 (targets.ts).
function dayStatus(
  plan: PlanView,
  dayIndex: number,
): "within_band" | "outside_band" | "incomplete" {
  const daySlots = plan.slots.filter((s) => s.dayIndex === dayIndex);
  if (daySlots.length < MEAL_TYPES.length) return "incomplete";

  const actual: MacroTargets = daySlots.reduce(
    (sum, slot) => ({
      calories: sum.calories + slot.calories + (slot.addon?.caloriesKcal ?? 0),
      proteinG: sum.proteinG + slot.proteinG + (slot.addon?.proteinG ?? 0),
      carbsG: sum.carbsG + slot.carbsG + (slot.addon?.carbsG ?? 0),
      fatG: sum.fatG + slot.fatG + (slot.addon?.fatG ?? 0),
    }),
    { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  );
  const dailyTarget: MacroTargets = {
    calories: plan.weeklyTarget.calories / DAYS_PER_WEEK,
    proteinG: plan.weeklyTarget.proteinG / DAYS_PER_WEEK,
    carbsG: plan.weeklyTarget.carbsG / DAYS_PER_WEEK,
    fatG: plan.weeklyTarget.fatG / DAYS_PER_WEEK,
  };
  return isWithinBand(actual, toleranceBand(dailyTarget)) ? "within_band" : "outside_band";
}

export function PlanBoard({
  initialPlan,
  dietaryStyles,
  dailyCalories,
  initialPantryItems,
}: {
  initialPlan: PlanView | null;
  dietaryStyles: string[];
  dailyCalories: number;
  initialPantryItems: PantryItemView[];
}) {
  const [plan, setPlan] = useState<PlanView | null>(initialPlan);
  const [blockedSlots, setBlockedSlots] = useState<BlockedSlotView[]>(initialPlan?.blockedSlots ?? []);
  const [generating, setGenerating] = useState(false);
  const [usingCachedFallback, setUsingCachedFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swappingKey, setSwappingKey] = useState<string | null>(null);

  const unsupportedStyles = unsupportedDietaryStyles(dietaryStyles);
  // Audit round 2 (July 15 2026), finding 3's remaining half: our own
  // MIN_DAILY_CALORIES floor (tdee.ts) keeps a COMPUTED target safely
  // above the meal-floor structural minimum, but onboarding lets a user
  // manually override dailyCalories below it -- this catches that case
  // honestly rather than silently generating a plan that's guaranteed to
  // land over target.
  const belowStructuralFloor = structuralCalorieFloorExceedsTarget(dailyCalories);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    setUsingCachedFallback(false);

    const result = await generatePlan();
    setGenerating(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    setPlan(result.plan);
    setBlockedSlots(result.plan?.blockedSlots ?? []);
    setUsingCachedFallback(result.usingCachedFallback);
  }

  async function handleSwap(dayIndex: number, mealType: MealType) {
    if (!plan) return;
    const key = slotMapKey(dayIndex, mealType);
    setSwappingKey(key);

    const result = await swapMeal({ mealPlanId: plan.id, dayIndex, mealType });
    setSwappingKey(null);

    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.blocked) {
      setBlockedSlots((prev) => [
        ...prev.filter((b) => slotMapKey(b.dayIndex, b.mealType) !== key),
        { dayIndex, mealType, blockingHint: result.blockingHint ?? "No alternative found." },
      ]);
      return;
    }
    if (result.slot) {
      setPlan((prev) =>
        prev
          ? {
              ...prev,
              slots: [...prev.slots.filter((s) => slotMapKey(s.dayIndex, s.mealType) !== key), result.slot!],
            }
          : prev,
      );
      setBlockedSlots((prev) => prev.filter((b) => slotMapKey(b.dayIndex, b.mealType) !== key));
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Your meal plan</h1>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating}
          className="rounded-lg bg-accent px-4 py-2 font-semibold text-white disabled:opacity-60"
        >
          {generating ? "Generating…" : plan ? "Regenerate" : "Generate my meal plan"}
        </button>
      </div>

      <div className="mt-6">
        <PantryPanel initialItems={initialPantryItems} />
      </div>

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}

      {usingCachedFallback && (
        <p className="mt-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          Using last week&apos;s plan — live generation is temporarily unavailable, try again shortly.
        </p>
      )}

      {plan && (
        <div className="mt-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
          <p className="font-semibold text-foreground">
            {plan.reconciliationStatus === "within_band"
              ? "This week is within your weekly targets"
              : "This week lands slightly outside your weekly targets"}
          </p>
          <p className="mt-1 font-mono text-xs text-muted">
            Calories: {Math.round(plan.weeklyActual.calories)} / {Math.round(plan.weeklyTarget.calories)} · Protein:{" "}
            {Math.round(plan.weeklyActual.proteinG)}g / {Math.round(plan.weeklyTarget.proteinG)}g · Carbs:{" "}
            {Math.round(plan.weeklyActual.carbsG)}g / {Math.round(plan.weeklyTarget.carbsG)}g · Fat:{" "}
            {Math.round(plan.weeklyActual.fatG)}g / {Math.round(plan.weeklyTarget.fatG)}g
          </p>
        </div>
      )}

      {unsupportedStyles.length > 0 && (
        <p className="mt-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          {unsupportedStyles.map((s) => s.replace("_", " ")).join(" / ")} aren&apos;t enforced by our
          recipe filters yet — please double-check ingredients.
        </p>
      )}

      {belowStructuralFloor && (
        <p className="mt-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          Your daily calorie target ({Math.round(dailyCalories)} cal) is low enough that this plan may
          run above it — we can&apos;t realistically make individual meals smaller than about{" "}
          {STRUCTURAL_CALORIE_FLOOR_TOTAL} cal combined. Consider raising your target if this plan looks
          too large.
        </p>
      )}

      {!plan && !generating && (
        <p className="mt-8 text-sm text-muted">No meal plan yet — generate one to get started.</p>
      )}

      {plan && (
        <div className="mt-8 flex flex-col gap-8">
          {DAY_LABELS.map((label, dayIndex) => {
            const status = dayStatus(plan, dayIndex);
            return (
            <div key={dayIndex}>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">{label}</h2>
                {status === "within_band" && (
                  <span className="text-xs font-semibold text-accent-2">On target</span>
                )}
                {status === "outside_band" && (
                  <span className="text-xs font-semibold text-muted">Slightly off target</span>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {MEAL_TYPES.map((mealType) => {
                  const key = slotMapKey(dayIndex, mealType);
                  const slot = plan.slots.find((s) => slotMapKey(s.dayIndex, s.mealType) === key);
                  const blocked = blockedSlots.find((b) => slotMapKey(b.dayIndex, b.mealType) === key);
                  return (
                    <MealCard
                      key={key}
                      mealType={mealType}
                      slot={slot}
                      blockingHint={blocked?.blockingHint ?? null}
                      swapping={swappingKey === key}
                      onSwap={() => handleSwap(dayIndex, mealType)}
                    />
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </main>
  );
}

function MealCard({
  mealType,
  slot,
  blockingHint,
  swapping,
  onSwap,
}: {
  mealType: MealType;
  slot: PlanSlotView | undefined;
  blockingHint: string | null;
  swapping: boolean;
  onSwap: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{MEAL_TYPE_LABELS[mealType]}</p>

      {slot ? (
        <>
          <p className="mt-1 text-sm font-semibold text-foreground">{slot.recipeTitle}</p>
          {slot.matchLabel && <p className="mt-1 text-xs text-muted">{slot.matchLabel}</p>}
          <p className="mt-2 font-mono text-xs text-muted">
            {Math.round(slot.calories)} cal · {Math.round(slot.proteinG)}g protein · {Math.round(slot.carbsG)}g
            carbs · {Math.round(slot.fatG)}g fat
          </p>
          {slot.isComposed ? (
            slot.composedIngredients && (
              <p className="mt-1 text-xs text-muted">
                {slot.composedIngredients.map((i) => `${Math.round(i.amountG)}g ${i.name}`).join(" + ")}
              </p>
            )
          ) : (
            <p className="mt-1 text-xs text-muted">
              {slot.servings > 1
                ? `Macros shown are for 1 serving — this recipe makes ${slot.servings}, so cook a fraction of it or plan for leftovers.`
                : "Makes 1 serving."}
            </p>
          )}
          {slot.aiComposed && (
            <p className="mt-1 text-xs text-muted">
              AI-composed — no Spoonacular recipe matched this meal, so this dish was assembled from real,
              grounded ingredient data instead.
            </p>
          )}
          {slot.addon && (
            <p className="mt-1 text-xs text-accent-2">
              + {Math.round(slot.addon.amountG)}g {slot.addon.ingredientName} added to help hit this week&apos;s
              targets ({Math.round(slot.addon.caloriesKcal)} cal)
            </p>
          )}
          <div className="mt-3 flex items-center justify-between">
            {slot.isComposed && !slot.aiComposed ? (
              <span className="text-xs text-muted">No recipe to cook — just combine and eat</span>
            ) : (
              <a
                href={recipeVideoSearchUrl(slot.recipeTitle)}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-semibold text-accent-2"
              >
                Watch how to cook this
              </a>
            )}
            <button
              type="button"
              onClick={onSwap}
              disabled={swapping}
              className="rounded-md border border-border px-2 py-1 text-xs font-semibold text-muted disabled:opacity-60"
            >
              {swapping ? "Swapping…" : "Swap"}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted">{blockingHint ?? "No recipe matched this meal yet."}</p>
      )}
    </div>
  );
}
