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
import { toleranceBand, isWithinBand, weeklyAccuracyTier } from "@/lib/mealplan/reconciliation";
import { unsupportedDietaryStyles } from "@/lib/mealplan/dietaryMapping";
import { generatePlan, swapMeal } from "./actions";
import type { BlockedSlotView, PlanSlotView, PlanView } from "./data";
import { PantryPanel } from "./PantryPanel";
import type { PantryItemView } from "./pantryData";
import { GroceryList } from "./GroceryList";
import type { GroceryLineView } from "./groceryData";
import { fetchGroceryList } from "./groceryActions";

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

// Spoonacular's serving multiplier is a real (not integer) scale factor —
// displaying its raw float (e.g. "2.0767144517628826") reads as broken.
// Rounded to 1 decimal for display only; the underlying macro/price fields
// already reflect the precise scaled amount, this is cosmetic.
function formatServings(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

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
  initialGroceryList,
  tier,
}: {
  initialPlan: PlanView | null;
  dietaryStyles: string[];
  dailyCalories: number;
  initialPantryItems: PantryItemView[];
  initialGroceryList: GroceryLineView[];
  tier: "free" | "pro";
}) {
  const [plan, setPlan] = useState<PlanView | null>(initialPlan);
  const [blockedSlots, setBlockedSlots] = useState<BlockedSlotView[]>(initialPlan?.blockedSlots ?? []);
  const [generating, setGenerating] = useState(false);
  const [usingCachedFallback, setUsingCachedFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swappingKey, setSwappingKey] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState(0);
  const [groceryList, setGroceryList] = useState<GroceryLineView[]>(initialGroceryList);

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
    setSelectedDay(0);

    // A fresh generation replaces every slot's ingredients, so the grocery
    // list must be recomputed against the new plan rather than reused.
    if (result.plan) {
      const groceryResult = await fetchGroceryList(result.plan.id);
      setGroceryList(groceryResult.lines);
    } else {
      setGroceryList([]);
    }
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
              weeklyActual: result.weeklyActual ?? prev.weeklyActual,
            }
          : prev,
      );
      setBlockedSlots((prev) => prev.filter((b) => slotMapKey(b.dayIndex, b.mealType) !== key));

      // The swapped slot's ingredients changed, so the grocery list must be
      // recomputed against the same plan rather than reused.
      const groceryResult = await fetchGroceryList(plan.id);
      setGroceryList(groceryResult.lines);
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

      {plan && (
        <div className="mt-6 rounded-lg border border-border bg-surface p-4">
          <p className="text-sm font-semibold text-foreground">
            {
              {
                on_target: "This week is within your weekly targets",
                close: "This week lands close to your weekly targets",
                off_target: "This week is meaningfully off your weekly targets",
              }[weeklyAccuracyTier(plan.weeklyActual, plan.weeklyTarget)]
            }
          </p>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <MacroStat label="Calories" unit=" cal" actual={plan.weeklyActual.calories} target={plan.weeklyTarget.calories} />
            <MacroStat label="Protein" unit="g" actual={plan.weeklyActual.proteinG} target={plan.weeklyTarget.proteinG} />
            <MacroStat label="Carbs" unit="g" actual={plan.weeklyActual.carbsG} target={plan.weeklyTarget.carbsG} />
            <MacroStat label="Fat" unit="g" actual={plan.weeklyActual.fatG} target={plan.weeklyTarget.fatG} />
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}

      {usingCachedFallback && (
        <p className="mt-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          Using last week&apos;s plan — live generation is temporarily unavailable, try again shortly.
        </p>
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
        <div className="mt-8">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {DAY_LABELS.map((label, dayIndex) => {
              const status = dayStatus(plan, dayIndex);
              const isSelected = dayIndex === selectedDay;
              return (
                <button
                  key={dayIndex}
                  type="button"
                  onClick={() => setSelectedDay(dayIndex)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors ${
                    isSelected
                      ? "border-accent bg-accent text-white"
                      : "border-border bg-surface text-muted"
                  }`}
                >
                  {label}
                  {status === "within_band" && (
                    <span className={isSelected ? "text-white" : "text-accent-2"}>●</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {MEAL_TYPES.map((mealType) => {
              const key = slotMapKey(selectedDay, mealType);
              const slot = plan.slots.find((s) => slotMapKey(s.dayIndex, s.mealType) === key);
              const blocked = blockedSlots.find((b) => slotMapKey(b.dayIndex, b.mealType) === key);
              return (
                <MealCard
                  key={key}
                  mealType={mealType}
                  slot={slot}
                  blockingHint={blocked?.blockingHint ?? null}
                  swapping={swappingKey === key}
                  onSwap={() => handleSwap(selectedDay, mealType)}
                />
              );
            })}
          </div>
        </div>
      )}

      <details className="mt-10 rounded-lg border border-border bg-surface">
        <summary className="cursor-pointer list-none p-4 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
          <span className="flex items-center justify-between">
            Pantry
            <span className="text-xs font-normal text-muted">Optional</span>
          </span>
        </summary>
        <div className="border-t border-border p-4 pt-3">
          <PantryPanel initialItems={initialPantryItems} />
        </div>
      </details>

      <details className="mt-4 rounded-lg border border-border bg-surface">
        <summary className="cursor-pointer list-none p-4 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
          <span className="flex items-center justify-between">
            Grocery list
            <span className="text-xs font-normal text-muted">{groceryList.length} items</span>
          </span>
        </summary>
        <div className="border-t border-border p-4 pt-3">
          <GroceryList lines={groceryList} tier={tier} />
        </div>
      </details>
    </main>
  );
}

function MacroStat({
  label,
  actual,
  target,
  unit,
}: {
  label: string;
  actual: number;
  target: number;
  unit: string;
}) {
  const pct = target > 0 ? Math.min(100, Math.round((actual / target) * 100)) : 0;
  return (
    <div>
      <span className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</span>
      <div className="mt-0.5 font-mono text-xs text-muted">
        {Math.round(actual)}
        {unit} / {Math.round(target)}
        {unit}
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MacroPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted">
      {children}
    </span>
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
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
      {slot?.imageUrl && (
        <div className="aspect-4/3 w-full shrink-0 bg-background">
          {/* eslint-disable-next-line @next/next/no-img-element -- external Spoonacular CDN, not worth a next.config remotePatterns entry for a thumbnail */}
          <img src={slot.imageUrl} alt={slot.recipeTitle} loading="lazy" className="h-full w-full object-cover" />
        </div>
      )}
      <div className="flex flex-1 flex-col p-3">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">{MEAL_TYPE_LABELS[mealType]}</p>

        {slot ? (
          <>
            <p className="mt-1 text-sm font-semibold text-foreground">{slot.recipeTitle}</p>
            {slot.matchLabel && <p className="mt-0.5 text-xs text-muted">{slot.matchLabel}</p>}

            <div className="mt-2 flex flex-wrap gap-1.5">
              <MacroPill>{Math.round(slot.calories)} cal</MacroPill>
              <MacroPill>{Math.round(slot.proteinG)}g protein</MacroPill>
              <MacroPill>{Math.round(slot.carbsG)}g carbs</MacroPill>
              <MacroPill>{Math.round(slot.fatG)}g fat</MacroPill>
            </div>

            {slot.isComposed ? (
              slot.composedIngredients && (
                <p className="mt-2 text-xs text-muted">
                  {slot.composedIngredients.map((i) => `${Math.round(i.amountG)}g ${i.name}`).join(" + ")}
                </p>
              )
            ) : (
              slot.servings > 1 && (
                <p className="mt-2 text-xs text-muted">
                  Makes {formatServings(slot.servings)} servings — cook a fraction or plan for leftovers.
                </p>
              )
            )}
            {slot.aiComposed && (
              <p className="mt-1 text-xs text-muted">
                AI-composed — no recipe matched, assembled from real ingredient data.
              </p>
            )}
            {slot.addon && (
              <p className="mt-1 text-xs text-accent-2">
                + {Math.round(slot.addon.amountG)}g {slot.addon.ingredientName} to help hit this week&apos;s
                targets ({Math.round(slot.addon.caloriesKcal)} cal)
              </p>
            )}

            <div className="mt-auto flex items-center justify-between pt-3">
              <span className="text-xs text-muted">
                {slot.isComposed && !slot.aiComposed ? "Combine and eat — no cooking" : ""}
              </span>
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
    </div>
  );
}
