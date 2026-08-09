"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
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
import { prepNoteFor } from "@/lib/mealplan/staticIngredientMacros";
import { generatePlan, swapMeal, getRecipeInstructions, getAiComposedRecipeInstructions } from "./actions";
import type { BlockedSlotView, ComposedIngredientView, PlanSlotView, PlanView } from "./data";
import { PantryPanel } from "./PantryPanel";
import type { PantryItemView } from "./pantryData";
import { GroceryList } from "./GroceryList";
import type { GroceryLineView } from "./groceryData";
import { fetchGroceryList } from "./groceryActions";
import { pluralizeUnit } from "./unitFormatting";
import { buildMealPlanIcs } from "./calendarExport";
import { pickDishIcon, type DishIconKind } from "./dishIcon";
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
  const rounded = Math.round(n * 10) / 10;
  return `${rounded} ${rounded === 1 ? "serving" : "servings"}`;
}

// Each pool ingredient's own prep note (if any) is now rendered inline next
// to that ingredient (see the composedIngredients list in MealCard), not
// dumped into a single bottom-of-card line -- with oats/edamame added to the
// pool (2026-07-30) a snack can have TWO ingredients that each carry a note
// (e.g. "10g oats — cook with water as oatmeal" AND "15g hemp seeds —
// sprinkle over the oats"), so a footer that could only surface one note
// silently dropped the other. This footer is now only the true "nothing
// needs prep" fallback -- and specifically must NOT fire when any ingredient
// already has a note, since some of those notes (oats) mean cooking IS
// involved, contradicting a blanket "no cooking" claim.
function composedSnackFooter(ingredients: ComposedIngredientView[] | null): string {
  const list = ingredients ?? [];
  const anyNote = list.some((ingredient, i) => {
    const otherNames = list.filter((_, j) => j !== i).map((o) => o.name);
    return prepNoteFor(ingredient.name, "snack", otherNames) !== null;
  });
  return anyNote ? "" : "Combine and eat — no cooking";
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
    <main className="mx-auto w-full min-w-0 max-w-3xl px-6 py-16">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Your meal plan</h1>
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
          <div className="flex gap-2 overflow-x-auto pb-1">
            {DAY_LABELS.map((label, dayIndex) => {
              const status = dayStatus(plan, dayIndex);
              const isSelected = dayIndex === selectedDay;
              return (
                <Pill
                  key={dayIndex}
                  active={isSelected}
                  onClick={() => setSelectedDay(dayIndex)}
                  className="flex shrink-0 items-center gap-1.5"
                >
                  {label}
                  {status === "within_band" && (
                    <span className={isSelected ? "text-white" : "text-accent-2"}>●</span>
                  )}
                </Pill>
              );
            })}
          </div>

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

// Placeholder for an AI-composed dish, which never has a real photo (2026-
// 07-30 UI pass -- these cards used to render nothing at all in the image
// slot, reading as noticeably plainer than every real-recipe card next to
// them). A plain stroke icon, not a color emoji, to stay monochrome/
// muted-toned like this app's other glyphs (✕/●/↗ below) rather than
// introducing a jarring colorful element. Picks one of a small set of
// dish-shape icons via a keyword match on the AI-generated title
// (pickDishIcon, dishIcon.ts) instead of always showing the same bowl --
// 2026-08-09, every AI-composed dish looked identical regardless of what
// it actually was.
const DISH_ICON_PATHS: Record<DishIconKind, ReactNode> = {
  smoothie: (
    <>
      <path d="M8 4h8l-1.2 15.2a2 2 0 0 1-2 1.8h-1.6a2 2 0 0 1-2-1.8L8 4z" />
      <path d="M7 4h10" />
      <path d="M14 1l2 3" />
    </>
  ),
  soup: (
    <>
      <circle cx="12" cy="15" r="6" />
      <path d="M9 4c0 1-1 1.2-1 2.2S9 7.4 9 8.4M12 3c0 1-1 1.2-1 2.2s1 1.2 1 2.2M15 4c0 1-1 1.2-1 2.2s1 1.2 1 2.2" />
    </>
  ),
  bowl: (
    <>
      <path d="M3 12h18" />
      <path d="M4 12a8 6.5 0 0 0 16 0" />
    </>
  ),
  skillet: (
    <>
      <circle cx="10" cy="13" r="7" />
      <path d="M17 13h5" />
    </>
  ),
  baked: (
    <>
      <rect x="4" y="9" width="16" height="9" rx="1.5" />
      <path d="M2 11.5h2M20 11.5h2" />
    </>
  ),
  sandwich: (
    <>
      <path d="M4 20L12 5l8 15z" />
      <path d="M7.2 15h9.6" />
    </>
  ),
  fallback: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
};

function ComposedDishPlaceholder({ recipeTitle }: { recipeTitle: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background text-muted">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {DISH_ICON_PATHS[pickDishIcon(recipeTitle)]}
      </svg>
    </div>
  );
}

function MealCard({
  mealType,
  slot,
  mealPlanId,
  blockingHint,
  swapping,
  onSwap,
}: {
  mealType: MealType;
  slot: PlanSlotView | undefined;
  mealPlanId: string;
  blockingHint: string | null;
  swapping: boolean;
  onSwap: () => void;
}) {
  const [showRecipe, setShowRecipe] = useState(false);
  // A real, non-composed recipe has ingredients/instructions worth a
  // separate detail view via Spoonacular; an AI-composed MEAL now gets the
  // same detail view too (2026-07-30), with instructions generated on
  // demand instead of fetched -- see RecipeModal. A plain composed SNACK
  // still doesn't: it already shows everything it has (its flat ingredient
  // list + "no cooking" footer) directly on the card, nothing to expand.
  const hasRecipeDetail = !!slot && !slot.isUnfilled && ((!slot.isComposed && slot.recipeId !== null) || slot.aiComposed);
  // AI-composed meals never have a real photo (nothing was ever fetched or
  // matched) -- shown with a placeholder instead of an empty slot, so the
  // card doesn't read as noticeably plainer than a real-recipe card next
  // to it. Composed snacks intentionally stay photo-free (they're not
  // "a dish," just a quick assembled snack).
  const showPlaceholderImage = !!slot && slot.aiComposed && !slot.imageUrl;

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
      {slot?.imageUrl ? (
        <div className="aspect-4/3 w-full shrink-0 bg-background">
          {/* eslint-disable-next-line @next/next/no-img-element -- external Spoonacular CDN, not worth a next.config remotePatterns entry for a thumbnail */}
          <img src={slot.imageUrl} alt={slot.recipeTitle} loading="lazy" className="h-full w-full object-cover" />
        </div>
      ) : (
        showPlaceholderImage && (
          <div className="aspect-4/3 w-full shrink-0">
            <ComposedDishPlaceholder recipeTitle={slot!.recipeTitle} />
          </div>
        )
      )}
      <div className="flex flex-1 flex-col p-3">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">{MEAL_TYPE_LABELS[mealType]}</p>

        {slot && !slot.isUnfilled ? (
          <>
            <p className="mt-1 text-sm font-semibold text-foreground">{slot.recipeTitle}</p>
            {/* slot.matchLabel ("Approximate...", "Closest match...", "Closest
                to your budget...") is deliberately not rendered -- surfacing
                match-quality/approximation caveats read as alarming or
                confusing on a meal card rather than useful, per Satya
                2026-08-01. Still computed/stored (matchLabelFor, orchestrate.ts)
                for internal use (ranking, ops debugging via the MCP route). */}

            <div className="mt-2 flex flex-wrap gap-1.5">
              <MacroPill>{Math.round(slot.calories + (slot.addon?.caloriesKcal ?? 0))} cal</MacroPill>
              <MacroPill>{Math.round(slot.proteinG + (slot.addon?.proteinG ?? 0))}g protein</MacroPill>
              <MacroPill>{Math.round(slot.carbsG + (slot.addon?.carbsG ?? 0))}g carbs</MacroPill>
              <MacroPill>{Math.round(slot.fatG + (slot.addon?.fatG ?? 0))}g fat</MacroPill>
            </div>

            {slot.isComposed ? (
              slot.composedIngredients && (
                <div className="mt-2 space-y-0.5">
                  {slot.composedIngredients.map((ingredient, i) => {
                    const otherNames = slot.composedIngredients!
                      .filter((_, j) => j !== i)
                      .map((other) => other.name);
                    // AI-composed dishes' ingredients (e.g. "diced russet
                    // potatoes") never match the fixed pool list below, so
                    // this is a no-op for them -- only real snack-pool
                    // ingredients (oats, chia/hemp seeds, etc.) get a note.
                    const note = prepNoteFor(ingredient.name, "snack", otherNames);
                    return (
                      <p key={`${ingredient.name}-${i}`} className="text-xs text-muted">
                        {`${Math.round(ingredient.amountG)}g ${ingredient.name}`}
                        {note ? ` — ${note}` : ""}
                      </p>
                    );
                  })}
                </div>
              )
            ) : (
              slot.servings > 1 && (
                <p className="mt-2 text-xs text-muted">
                  Makes {formatServings(slot.servings)} — cook a fraction or plan for leftovers.
                </p>
              )
            )}
            {/* slot.aiComposed's "AI-composed -- no recipe matched..." label
                is deliberately not rendered, same reasoning as matchLabel
                above (Satya 2026-08-01) -- slot.aiComposed itself is still
                set and used elsewhere (e.g. the plan critic skips repetition
                flags on composed slots). */}
            {slot.addon && (
              // A single template literal, not JSX text split across lines --
              // the line-wrapped text below this cost a real space (JSX's
              // whitespace collapsing silently ate the space after
              // {slot.addon.ingredientName}, rendering "almondsto help...").
              // Appends a realism note for the handful of pool ingredients
              // (protein powder, chia/hemp seeds) that aren't eaten standalone
              // as-is -- see staticIngredientMacros.ts's prepNoteFor for why
              // the note only ever points at water or the meal this addon is
              // already attached to, never an untracked outside food.
              // Neutral (text-muted), not accent-2 (2026-07-30 UI pass) --
              // this is a normal helpful note, same tone as the rest of the
              // card's small text; the accent color read as a warning/error
              // next to everything else, which it isn't.
              <p className="mt-1 text-xs text-muted">
                {`+ ${Math.round(slot.addon.amountG)}g ${slot.addon.ingredientName} to help hit this week's targets (${Math.round(slot.addon.caloriesKcal)} cal)`}
                {(() => {
                  const note = prepNoteFor(slot.addon.ingredientName, "addon", []);
                  return note ? ` — ${note}` : "";
                })()}
              </p>
            )}

            <div className="mt-auto flex items-center justify-between pt-3">
              <span className="text-xs text-muted">
                {slot.isComposed && !slot.aiComposed
                  ? composedSnackFooter(slot.composedIngredients)
                  : ""}
              </span>
              <div className="flex gap-2">
                {hasRecipeDetail && (
                  <Button variant="secondary" onClick={() => setShowRecipe(true)} className="px-2 py-1 text-xs">
                    Recipe
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={onSwap}
                  loading={swapping}
                  loadingText="Swapping"
                  className="px-2 py-1 text-xs"
                >
                  Swap
                </Button>
              </div>
            </div>
          </>
        ) : (
          // Persona audit 2026-07-31, finding #3 (Phase 4): a persisted
          // 'unfilled' slot (slot.isUnfilled) carries the honest reason
          // directly in recipeTitle (see data.ts) -- takes priority over
          // the ephemeral blockingHint prop, which only exists for the
          // immediate post-generation render before this slot had a real
          // row (both describe the same thing once persisted).
          <p className="mt-2 text-xs text-muted">
            {slot?.isUnfilled ? slot.recipeTitle : (blockingHint ?? "No recipe matched this meal yet.")}
          </p>
        )}
      </div>
      {showRecipe && slot && (
        <RecipeModal
          key={`${mealPlanId}-${slot.dayIndex}-${slot.mealType}-${slot.recipeId}-${slot.aiComposed}`}
          slot={slot}
          mealPlanId={mealPlanId}
          onClose={() => setShowRecipe(false)}
        />
      )}
    </div>
  );
}

// Modeled on the common recipe-app detail pattern (Mealime/Whisk/AllRecipes):
// image -> ingredients -> numbered steps, with a source link as the honest
// fallback when Spoonacular has no structured steps for this recipe (not
// every recipe in its corpus does). A modal (not inline expansion) keeps the
// card grid's height uniform — an inline expansion would shove every other
// card in the row down whenever one recipe's step list is long.
function RecipeModal({ slot, mealPlanId, onClose }: { slot: PlanSlotView; mealPlanId: string; onClose: () => void }) {
  const [instructions, setInstructions] = useState<{ steps: string[]; sourceUrl: string | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by the Retry button to re-run the fetch effect below -- a
  // "recipe details unavailable" result is usually just a transient
  // Spoonacular rate-limit/outage hitting right after a heavy-traffic
  // generation, not a permanent gap (see recipeInstructions.ts's own
  // comment); retrying this one recipe shouldn't require regenerating the
  // whole plan.
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (slot.recipeId === null && !slot.aiComposed) return;
    let cancelled = false;
    // AI-composed meals get generated instructions (2026-07-30, on demand,
    // cached server-side after the first open) instead of a Spoonacular
    // fetch -- same {steps, error} shape either way, so the render logic
    // below doesn't need to know which path produced it.
    const fetchInstructions =
      slot.aiComposed
        ? getAiComposedRecipeInstructions({ mealPlanId, dayIndex: slot.dayIndex, mealType: slot.mealType }).then((result) => ({
            ...result,
            sourceUrl: null as string | null,
          }))
        : getRecipeInstructions(slot.recipeId!);
    fetchInstructions.then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.error) {
        setLoadError(result.error);
        return;
      }
      setInstructions({ steps: result.steps, sourceUrl: result.sourceUrl });
    });
    return () => {
      cancelled = true;
    };
  }, [slot.recipeId, slot.aiComposed, slot.dayIndex, slot.mealType, mealPlanId, retryCount]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        {slot.imageUrl ? (
          <div className="aspect-16/9 w-full shrink-0 bg-background">
            {/* eslint-disable-next-line @next/next/no-img-element -- external Spoonacular CDN, same as the card thumbnail above */}
            <img src={slot.imageUrl} alt={slot.recipeTitle} className="h-full w-full object-cover" />
          </div>
        ) : (
          slot.aiComposed && (
            <div className="aspect-16/9 w-full shrink-0">
              <ComposedDishPlaceholder recipeTitle={slot.recipeTitle} />
            </div>
          )
        )}
        <div className="overflow-y-auto p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">{slot.recipeTitle}</h2>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 text-sm font-semibold text-muted"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <MacroPill>{Math.round(slot.calories)} cal</MacroPill>
            <MacroPill>{Math.round(slot.proteinG)}g protein</MacroPill>
            <MacroPill>{Math.round(slot.carbsG)}g carbs</MacroPill>
            <MacroPill>{Math.round(slot.fatG)}g fat</MacroPill>
            <MacroPill>{formatServings(slot.servings)}</MacroPill>
          </div>

          {slot.recipeIngredients && slot.recipeIngredients.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Ingredients</h3>
              <ul className="mt-2 flex flex-col gap-1 text-sm text-foreground">
                {slot.recipeIngredients.map((ing, i) => (
                  <li key={i}>
                    {formatIngredientAmount(ing.amount, ing.unit)} {ing.name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* AI-composed meals have no recipeIngredients (no real recipe
              was ever fetched) -- same layout as the block above, reusing
              the composedIngredients data already shown on the card
              itself, just styled to match a real recipe's Ingredients
              section (2026-07-30, "similar UI to real Spoonacular meals"). */}
          {slot.aiComposed && slot.composedIngredients && slot.composedIngredients.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Ingredients</h3>
              <ul className="mt-2 flex flex-col gap-1 text-sm text-foreground">
                {slot.composedIngredients.map((ing, i) => (
                  <li key={i}>
                    {Math.round(ing.amountG)}g {ing.name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Instructions</h3>
            {loading && (
              <div className="mt-2 flex flex-col gap-2" aria-label="Loading instructions">
                <div className="h-3.5 w-full animate-pulse motion-reduce:animate-none rounded bg-border" />
                <div className="h-3.5 w-5/6 animate-pulse motion-reduce:animate-none rounded bg-border" />
                <div className="h-3.5 w-2/3 animate-pulse motion-reduce:animate-none rounded bg-border" />
              </div>
            )}
            {!loading && loadError && (
              <div className="mt-2 flex items-center gap-3">
                <p className="text-sm text-muted">{loadError}</p>
                <button
                  type="button"
                  onClick={() => {
                    setLoading(true);
                    setLoadError(null);
                    setRetryCount((c) => c + 1);
                  }}
                  className="shrink-0 text-sm font-semibold text-accent hover:underline"
                >
                  Retry
                </button>
              </div>
            )}
            {!loading && !loadError && instructions && instructions.steps.length > 0 && (
              <ol className="mt-2 flex flex-col gap-2 text-sm text-foreground">
                {instructions.steps.map((step, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-muted">{i + 1}.</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            )}
            {!loading && !loadError && instructions && instructions.steps.length === 0 && (
              <p className="mt-2 text-sm text-muted">
                No step-by-step instructions available for this recipe.
              </p>
            )}
            {!loading && !loadError && instructions?.sourceUrl && (
              <a
                href={instructions.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-sm font-semibold text-accent-2"
              >
                View original recipe ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// 1 decimal, same rounding as GroceryList.tsx's formatAmount -- a scaled
// ingredient amount (e.g. 12.67 almonds) reads as more precise than a home
// cook would ever actually measure.
function formatIngredientAmount(amount: number, unit: string): string {
  const rounded = Math.round(amount * 10) / 10;
  return unit ? `${rounded} ${pluralizeUnit(unit, rounded)}` : `${rounded}`;
}
