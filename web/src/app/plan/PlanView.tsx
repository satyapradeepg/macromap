"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { MacroRings } from "./MacroRings";
import { DayRibbon } from "./DayRibbon";
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
import { generatePlan, swapMeal } from "./actions";
import type { BlockedSlotView, PlanSlotView, PlanView } from "./data";
import { PantryPanel } from "./PantryPanel";
import type { PantryItemView } from "./pantryData";
import { GroceryList } from "./GroceryList";
import type { GroceryLineView } from "./groceryData";
import { fetchGroceryList } from "./groceryActions";
import { buildMealPlanIcs } from "./calendarExport";
import { runWithViewTransition } from "@/lib/viewTransition";
import { MealCard, MEAL_TYPE_LABELS } from "./MealCard";
import { GeneratingProgress } from "@/components/ui/GeneratingProgress";
import { notify } from "@/lib/toast";
import { ChatWidget } from "./ChatWidget";

// day_index (0-6) was never actually tied to a real Monday-Sunday week --
// a plan can be generated/regenerated any day, so labeling it with real
// weekday names implied a fixed-week alignment that doesn't exist. Renamed
// 2026-08-08 (Satya's call) to match what it actually is: a rolling 7-day
// plan starting from whenever it was generated. See calendarExport.ts for
// the matching change on the export side (day_index 0 = today, always).
const DAY_LABELS = ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"];

function slotMapKey(dayIndex: number, mealType: MealType): string {
  return `${dayIndex}-${mealType}`;
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
}: {
  initialPlan: PlanView | null;
  dietaryStyles: string[];
  dailyCalories: number;
  initialPantryItems: PantryItemView[];
  initialGroceryList: GroceryLineView[];
}) {
  const [plan, setPlan] = useState<PlanView | null>(initialPlan);
  const [blockedSlots, setBlockedSlots] = useState<BlockedSlotView[]>(initialPlan?.blockedSlots ?? []);
  const [generating, setGenerating] = useState(false);
  const [usingCachedFallback, setUsingCachedFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swappingKey, setSwappingKey] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState(0);
  const [groceryList, setGroceryList] = useState<GroceryLineView[]>(initialGroceryList);
  // PantryPanel owns its own displayed list internally, seeded once from
  // initialItems (uncontrolled, same as every other action-driven panel in
  // this file) -- a chat-driven pantry edit can't reach into that internal
  // state directly, so it's tracked here instead and force-remounts
  // PantryPanel (via the key) with a fresh seed whenever it changes.
  const [currentPantryItems, setCurrentPantryItems] = useState<PantryItemView[]>(initialPantryItems);
  const [pantryVersion, setPantryVersion] = useState(0);

  const unsupportedStyles = unsupportedDietaryStyles(dietaryStyles);
  // Audit round 2 (July 15 2026), finding 3's remaining half: our own
  // MIN_DAILY_CALORIES floor (tdee.ts) keeps a COMPUTED target safely
  // above the meal-floor structural minimum, but onboarding lets a user
  // manually override dailyCalories below it -- this catches that case
  // honestly rather than silently generating a plan that's guaranteed to
  // land over target.
  const belowStructuralFloor = structuralCalorieFloorExceedsTarget(dailyCalories);

  async function handleGenerate() {
    const hadExistingPlan = !!plan;
    setGenerating(true);
    setError(null);
    setUsingCachedFallback(false);

    // Live-confirmed 2026-08-09 (real user report + reproduced directly):
    // a slow generation can exceed the platform's own gateway timeout
    // (measured at exactly 120s), which surfaces as a rejected fetch/
    // thrown error here, not a normal `{ error: ... }` result -- there was
    // no try/catch at all, so that throw propagated past `setGenerating
    // (false)` below and left the button stuck showing "Generating"
    // forever, recoverable only by a manual page refresh. The generation
    // itself likely keeps running server-side past the gateway's own
    // cutoff (a refresh typically shows the completed plan), so the
    // message below says that honestly rather than implying it failed.
    let result;
    try {
      result = await generatePlan();
    } catch {
      setGenerating(false);
      setError(
        "This is taking longer than the page can wait for. It may still finish in the background -- try refreshing in a minute to check.",
      );
      return;
    }
    setGenerating(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    setPlan(result.plan);
    setBlockedSlots(result.plan?.blockedSlots ?? []);
    setUsingCachedFallback(result.usingCachedFallback);
    setSelectedDay(0);
    // Not toasted when usingCachedFallback -- that path already has its
    // own persistent inline banner ("Using last week's plan..."), a toast
    // alongside it would be redundant at best, conflicting at worst.
    if (result.plan && !result.usingCachedFallback) {
      notify(hadExistingPlan ? "Plan regenerated" : "Plan generated");
    }

    // A fresh generation replaces every slot's ingredients, so the grocery
    // list must be recomputed against the new plan rather than reused.
    if (result.plan) {
      const groceryResult = await fetchGroceryList(result.plan.id);
      setGroceryList(groceryResult.lines);
    } else {
      setGroceryList([]);
    }
  }

  function handleExportCalendar() {
    if (!plan) return;
    const blob = new Blob([buildMealPlanIcs(plan)], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "meal-plan.ics";
    link.click();
    URL.revokeObjectURL(url);
  }

  // Adding/removing a pantry item changes what aggregate.ts's
  // applyPantryItems subtracts from the grocery list, but that list lives
  // in this component's own state, not the pantry's -- without an
  // explicit refetch here, the grocery panel kept showing the stale,
  // unreduced list until a full page reload (bug found live 2026-07-25).
  async function handlePantryChange() {
    if (!plan) return;
    const groceryResult = await fetchGroceryList(plan.id);
    setGroceryList(groceryResult.lines);
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
      notify("Meal swapped");

      // The swapped slot's ingredients changed, so the grocery list must be
      // recomputed against the same plan rather than reused.
      const groceryResult = await fetchGroceryList(plan.id);
      setGroceryList(groceryResult.lines);
    }
  }

  // The three callbacks below are ChatWidget's only way to affect this
  // component's state -- same "server returns fresh state, client replaces
  // it wholesale" convention handleSwap/handleGenerate already follow, just
  // triggered from the chat server action instead of a button's own handler.
  async function handleChatSlotReplaced(slot: PlanSlotView, weeklyActual: MacroTargets) {
    if (!plan) return;
    const key = slotMapKey(slot.dayIndex, slot.mealType);
    setPlan((prev) => (prev ? { ...prev, slots: [...prev.slots.filter((s) => slotMapKey(s.dayIndex, s.mealType) !== key), slot], weeklyActual } : prev));
    setBlockedSlots((prev) => prev.filter((b) => slotMapKey(b.dayIndex, b.mealType) !== key));
    const groceryResult = await fetchGroceryList(plan.id);
    setGroceryList(groceryResult.lines);
  }

  function handleChatPlanReplaced(newPlan: PlanView) {
    setPlan(newPlan);
    setBlockedSlots(newPlan.blockedSlots ?? []);
    setSelectedDay(0);
    fetchGroceryList(newPlan.id).then((groceryResult) => setGroceryList(groceryResult.lines));
  }

  function handleChatPantryReplaced(items: PantryItemView[]) {
    setCurrentPantryItems(items);
    setPantryVersion((v) => v + 1);
    if (plan) {
      fetchGroceryList(plan.id).then((groceryResult) => setGroceryList(groceryResult.lines));
    }
  }

  return (
    // w-full is the real fix for a real mobile-width bug found live
    // 2026-07-25 -- this <main> is a flex item of layout.tsx's root
    // wrapper (flex flex-col), and `mx-auto` (auto left/right margins)
    // disables flexbox's default cross-axis stretch for a flex item, a
    // documented CSS behavior. Without an explicit width, that meant this
    // <main> sized itself to its WIDEST descendant's content (the day
    // selector row below, up to ~455px) instead of the actual viewport
    // (375px on a phone), pushing the whole page into real horizontal
    // overflow -- confirmed live: "Swap"/"Recipe" buttons and grocery
    // prices were silently clipped off-screen on a narrow viewport, not
    // just cosmetically tight. `min-w-0` alone (the more commonly-cited
    // flexbox overflow fix, for the OTHER classic cause -- a flex item's
    // default min-width:auto refusing to shrink) did NOT fix this; only
    // adding an explicit `w-full` did, confirmed by direct computed-style
    // inspection (align-items resolved to "normal"/stretch, but the auto
    // margins from mx-auto override it regardless). Kept min-w-0 anyway
    // as cheap insurance against the OTHER cause resurfacing separately.
    // pb-28 (not the top's py-16/pt-16) -- ChatWidget's collapsed launcher
    // button is `fixed bottom-4 right-4`, so it floats over whatever
    // content is currently at the bottom of the viewport rather than
    // taking up normal flow space. The true, permanent version of that
    // (not just a momentary mid-scroll overlap that clears on its own)
    // is at the actual end of the page: without enough reserved space
    // here, the last few lines of the Grocery list/Pantry sections can
    // end up permanently stuck under the button with no further scrolling
    // able to reveal them. 112px is a comfortable margin above the
    // button's own ~60px footprint (height + its bottom-4 offset).
    <main className="mx-auto w-full min-w-0 max-w-3xl px-6 pt-16 pb-28">
      {generating && (
        <GeneratingProgress heading={plan ? "Regenerating your meal plan" : "Generating your meal plan"} />
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl font-bold">Your meal plan</h1>
        <div className="flex items-center gap-3">
          {plan && (
            <button type="button" onClick={handleExportCalendar} className="text-xs font-semibold text-muted">
              Export to Calendar
            </button>
          )}
          <Button variant="primary" onClick={handleGenerate} loading={generating} loadingText="Generating">
            {plan ? "Regenerate" : "Generate my meal plan"}
          </Button>
        </div>
      </div>

      {plan && <MacroRings actual={plan.weeklyActual} target={plan.weeklyTarget} />}

      {plan && plan.unresolvedDietaryConcerns.length > 0 && (
        // Ephemeral, same as blockedSlots -- orchestrate.ts's repair pass
        // computes this in memory during generation but nothing persists
        // it, so a reloaded plan can't recover it (see data.ts). A genuine
        // diet_violation the repair pass tried and failed to fix even
        // after a real swap attempt and the AI-composition fallback --
        // expected empty in the overwhelming majority of plans, so this
        // gets a visually distinct (not just muted-gray) warning treatment
        // rather than blending in with routine plan-quality notes.
        <div className="mt-4 rounded-lg border border-amber-600/40 bg-amber-50 p-4 dark:bg-amber-950/30">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Couldn&apos;t fully resolve a dietary concern
          </p>
          <ul className="mt-2 space-y-1 text-sm text-amber-800 dark:text-amber-300">
            {plan.unresolvedDietaryConcerns.map((concern, i) => (
              <li key={i}>
                <span className="font-medium">
                  {DAY_LABELS[concern.dayIndex]} {MEAL_TYPE_LABELS[concern.mealType]}:
                </span>{" "}
                {concern.note}
              </li>
            ))}
          </ul>
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
          {/* A single template literal, not JSX text wrapped across lines --
              line-wrapped JSX text immediately after an expression silently
              drops the leading space on compile (see MealCard's addon note
              above for the same incident), rendering "halalaren't enforced"
              with no space at all -- live-confirmed 2026-07-31.

              Reworded the same day once openEndedIngredientSafety.ts's
              halalViolation/kosherViolation shipped real pork/alcohol/
              shellfish keyword exclusion -- "aren't enforced at all" was
              no longer accurate, but neither is silently dropping the
              disclaimer: it's a keyword check, not a certified/zabiha-
              verified guarantee, so the caveat stays, just corrected. */}
          {`${unsupportedStyles.map((s) => s.replace("_", " ")).join(" / ")}: recognized pork, alcohol, and shellfish are excluded automatically, but this is a keyword-based check, not a certified or zabiha-verified guarantee — please still double-check ingredients.`}
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
          <DayRibbon
            dayLabels={DAY_LABELS}
            selectedDay={selectedDay}
            onSelect={(dayIndex) => runWithViewTransition(() => setSelectedDay(dayIndex))}
            statusFor={(dayIndex) => dayStatus(plan, dayIndex)}
          />

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MEAL_TYPES.map((mealType) => {
              const key = slotMapKey(selectedDay, mealType);
              const slot = plan.slots.find((s) => slotMapKey(s.dayIndex, s.mealType) === key);
              const blocked = blockedSlots.find((b) => slotMapKey(b.dayIndex, b.mealType) === key);
              return (
                <MealCard
                  key={key}
                  mealType={mealType}
                  slot={slot}
                  mealPlanId={plan.id}
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
          <PantryPanel key={pantryVersion} initialItems={currentPantryItems} onPantryChange={handlePantryChange} />
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
          <GroceryList lines={groceryList} />
        </div>
      </details>

      <ChatWidget
        onSlotReplaced={handleChatSlotReplaced}
        onPlanReplaced={handleChatPlanReplaced}
        onPantryReplaced={handleChatPantryReplaced}
      />
    </main>
  );
}

