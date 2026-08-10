"use client";

import { useEffect, useState } from "react";
import { getRecipeInstructions, getAiComposedRecipeInstructions } from "./actions";
import type { PlanSlotView } from "./data";
import { pluralizeUnit } from "./unitFormatting";
import { MacroPill, ComposedDishPlaceholder, formatServings } from "./MealCard";

// Extracted from PlanView.tsx (2026-08-10 redesign) -- fetch/retry/escape-
// key logic moved byte-for-byte, only the JSX/styling changed.
//
// Modeled on the common recipe-app detail pattern (Mealime/Whisk/AllRecipes):
// image -> ingredients -> numbered steps, with a source link as the honest
// fallback when Spoonacular has no structured steps for this recipe (not
// every recipe in its corpus does). A modal (not inline expansion) keeps the
// card grid's height uniform — an inline expansion would shove every other
// card in the row down whenever one recipe's step list is long.

// 1 decimal, same rounding as GroceryList.tsx's formatAmount -- a scaled
// ingredient amount (e.g. 12.67 almonds) reads as more precise than a home
// cook would ever actually measure.
function formatIngredientAmount(amount: number, unit: string): string {
  const rounded = Math.round(amount * 10) / 10;
  return unit ? `${rounded} ${pluralizeUnit(unit, rounded)}` : `${rounded}`;
}

export function RecipeModal({ slot, mealPlanId, onClose }: { slot: PlanSlotView; mealPlanId: string; onClose: () => void }) {
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
      className="animate-chat-in motion-reduce:animate-none fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-surface shadow-[var(--shadow-lift)]"
        onClick={(e) => e.stopPropagation()}
      >
        {slot.imageUrl ? (
          <div className="aspect-16/9 w-full shrink-0 bg-paper-sunken">
            {/* eslint-disable-next-line @next/next/no-img-element -- external Spoonacular CDN, same as the card thumbnail above */}
            <img src={slot.imageUrl} alt={slot.recipeTitle} className="h-full w-full object-cover" />
          </div>
        ) : (
          slot.aiComposed && (
            <div className="aspect-16/9 w-full shrink-0">
              <ComposedDishPlaceholder
                recipeTitle={slot.recipeTitle}
                proteinG={slot.proteinG}
                carbsG={slot.carbsG}
                fatG={slot.fatG}
              />
            </div>
          )
        )}
        <div className="overflow-y-auto p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-display text-lg font-bold text-foreground">{slot.recipeTitle}</h2>
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
            <MacroPill tone="protein">{Math.round(slot.proteinG)}g protein</MacroPill>
            <MacroPill tone="carbs">{Math.round(slot.carbsG)}g carbs</MacroPill>
            <MacroPill tone="fat">{Math.round(slot.fatG)}g fat</MacroPill>
            <MacroPill>{formatServings(slot.servings)}</MacroPill>
          </div>

          {slot.recipeIngredients && slot.recipeIngredients.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Ingredients</h3>
              <ul className="mt-2 flex flex-col gap-1 font-mono text-sm text-foreground">
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
              <ul className="mt-2 flex flex-col gap-1 font-mono text-sm text-foreground">
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
