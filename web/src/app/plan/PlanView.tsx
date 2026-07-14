"use client";

import { useState } from "react";
import { MEAL_TYPES, type MealType } from "@/lib/mealplan/targets";
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

export function PlanBoard({
  initialPlan,
  dietaryStyles,
  initialPantryItems,
}: {
  initialPlan: PlanView | null;
  dietaryStyles: string[];
  initialPantryItems: PantryItemView[];
}) {
  const [plan, setPlan] = useState<PlanView | null>(initialPlan);
  const [blockedSlots, setBlockedSlots] = useState<BlockedSlotView[]>(initialPlan?.blockedSlots ?? []);
  const [generating, setGenerating] = useState(false);
  const [usingCachedFallback, setUsingCachedFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swappingKey, setSwappingKey] = useState<string | null>(null);

  const unsupportedStyles = unsupportedDietaryStyles(dietaryStyles);

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

      {plan?.reconciliationStatus === "outside_band_after_retries" && (
        <div className="mt-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          <p className="font-semibold text-foreground">This week lands slightly outside your weekly targets</p>
          <p className="mt-1">
            Target: {Math.round(plan.weeklyTarget.calories)} cal · {Math.round(plan.weeklyTarget.proteinG)}g
            protein — Actual: {Math.round(plan.weeklyActual.calories)} cal ·{" "}
            {Math.round(plan.weeklyActual.proteinG)}g protein.
          </p>
        </div>
      )}

      {unsupportedStyles.length > 0 && (
        <p className="mt-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          {unsupportedStyles.map((s) => s.replace("_", " ")).join(" / ")} aren&apos;t enforced by our
          recipe filters yet — please double-check ingredients.
        </p>
      )}

      {!plan && !generating && (
        <p className="mt-8 text-sm text-muted">No meal plan yet — generate one to get started.</p>
      )}

      {plan && (
        <div className="mt-8 flex flex-col gap-8">
          {DAY_LABELS.map((label, dayIndex) => (
            <div key={dayIndex}>
              <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">{label}</h2>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
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
          ))}
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
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{mealType}</p>

      {slot ? (
        <>
          <p className="mt-1 text-sm font-semibold text-foreground">{slot.recipeTitle}</p>
          {slot.matchLabel && <p className="mt-1 text-xs text-muted">{slot.matchLabel}</p>}
          <p className="mt-2 font-mono text-xs text-muted">
            {Math.round(slot.calories)} cal · {Math.round(slot.proteinG)}g protein · {Math.round(slot.carbsG)}g
            carbs · {Math.round(slot.fatG)}g fat
          </p>
          {slot.addon && (
            <p className="mt-1 text-xs text-accent-2">
              + {Math.round(slot.addon.amountG)}g {slot.addon.ingredientName} added to help hit this week&apos;s
              targets ({Math.round(slot.addon.caloriesKcal)} cal)
            </p>
          )}
          <div className="mt-3 flex items-center justify-between">
            <a
              href={recipeVideoSearchUrl(slot.recipeTitle)}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-semibold text-accent-2"
            >
              Watch how to cook this
            </a>
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
