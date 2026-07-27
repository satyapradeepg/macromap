"use client";

import { useEffect, useState } from "react";
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
import { generatePlan, swapMeal, getRecipeInstructions } from "./actions";
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
  const rounded = Math.round(n * 10) / 10;
  return `${rounded} ${rounded === 1 ? "serving" : "servings"}`;
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
          <PantryPanel initialItems={initialPantryItems} onPantryChange={handlePantryChange} />
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
  const [showRecipe, setShowRecipe] = useState(false);
  // Only a real, non-composed recipe has ingredients/instructions worth a
  // separate detail view — composed snacks/AI-composed meals already show
  // everything they have (their flat ingredient list) directly on the card.
  const hasRecipeDetail = !!slot && !slot.isComposed && slot.recipeId !== null;

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
                  Makes {formatServings(slot.servings)} — cook a fraction or plan for leftovers.
                </p>
              )
            )}
            {slot.aiComposed && (
              <p className="mt-1 text-xs text-muted">
                AI-composed — no recipe matched, assembled from real ingredient data.
              </p>
            )}
            {slot.addon && (
              // A single template literal, not JSX text split across lines --
              // the line-wrapped text below this cost a real space (JSX's
              // whitespace collapsing silently ate the space after
              // {slot.addon.ingredientName}, rendering "almondsto help...").
              <p className="mt-1 text-xs text-accent-2">
                {`+ ${Math.round(slot.addon.amountG)}g ${slot.addon.ingredientName} to help hit this week's targets (${Math.round(slot.addon.caloriesKcal)} cal)`}
              </p>
            )}

            <div className="mt-auto flex items-center justify-between pt-3">
              <span className="text-xs text-muted">
                {slot.isComposed && !slot.aiComposed ? "Combine and eat — no cooking" : ""}
              </span>
              <div className="flex gap-2">
                {hasRecipeDetail && (
                  <button
                    type="button"
                    onClick={() => setShowRecipe(true)}
                    className="rounded-md border border-border px-2 py-1 text-xs font-semibold text-muted"
                  >
                    Recipe
                  </button>
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
            </div>
          </>
        ) : (
          <p className="mt-2 text-xs text-muted">{blockingHint ?? "No recipe matched this meal yet."}</p>
        )}
      </div>
      {showRecipe && slot && <RecipeModal slot={slot} onClose={() => setShowRecipe(false)} />}
    </div>
  );
}

// Modeled on the common recipe-app detail pattern (Mealime/Whisk/AllRecipes):
// image -> ingredients -> numbered steps, with a source link as the honest
// fallback when Spoonacular has no structured steps for this recipe (not
// every recipe in its corpus does). A modal (not inline expansion) keeps the
// card grid's height uniform — an inline expansion would shove every other
// card in the row down whenever one recipe's step list is long.
function RecipeModal({ slot, onClose }: { slot: PlanSlotView; onClose: () => void }) {
  const [instructions, setInstructions] = useState<{ steps: string[]; sourceUrl: string | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (slot.recipeId === null) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    getRecipeInstructions(slot.recipeId).then((result) => {
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
  }, [slot.recipeId]);

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
        {slot.imageUrl && (
          <div className="aspect-16/9 w-full shrink-0 bg-background">
            {/* eslint-disable-next-line @next/next/no-img-element -- external Spoonacular CDN, same as the card thumbnail above */}
            <img src={slot.imageUrl} alt={slot.recipeTitle} className="h-full w-full object-cover" />
          </div>
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

          <div className="mt-4">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Instructions</h3>
            {loading && <p className="mt-2 text-sm text-muted">Loading…</p>}
            {!loading && loadError && <p className="mt-2 text-sm text-muted">{loadError}</p>}
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
  return unit ? `${rounded} ${unit}` : `${rounded}`;
}
