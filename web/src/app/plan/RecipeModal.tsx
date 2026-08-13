"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  // Purely local, resets on reopen -- a "did I already add this" checklist
  // while actually cooking, not a saved preference (nothing here should
  // survive closing the modal, same lifecycle as the ingredient list itself).
  const [checkedIngredients, setCheckedIngredients] = useState<Set<number>>(new Set());

  function toggleIngredient(i: number) {
    setCheckedIngredients((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

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

  // Without this, the background page can still scroll while the modal is
  // open (this is a fixed overlay, not a true focus trap) -- on mobile
  // that scroll hides/shows the browser's own toolbar, which changes the
  // *actual* viewport height moment to moment. `85dvh` below recalculates
  // against that shifting height on every scroll tick, which is what reads
  // as the modal glitching/flickering to a different size while scrolling
  // "outside" it without closing it. Locking `documentElement` too (not
  // just `body`) is required -- layout.tsx's `<html>` carries the actual
  // scroll box in this app (`document.scrollingElement === document.
  // documentElement`, confirmed live), so a body-only lock silently does
  // nothing and the background keeps scrolling anyway.
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, []);

  // Portaled to <body> rather than rendered where MealCard placed it --
  // MealCard's own card root has `hover:-translate-y-0.5` (an active
  // transform while hovered/tapped), and per spec any ancestor with a
  // non-none transform becomes the containing block for a `fixed`
  // descendant. Without the portal, this modal would silently become
  // fixed relative to that card instead of the viewport whenever it's
  // hovered (or stuck in a touch-device's persistent tap-hover state),
  // which is what made it drift and snap while scrolling the page behind
  // it -- confirmed live, this was the real cause, not just the dvh/
  // scroll-lock issue above.
  return createPortal(
    <div
      className="animate-chat-in motion-reduce:animate-none fixed inset-0 z-50 flex items-center justify-center bg-black/50 sm:p-4"
      onClick={onClose}
    >
      {/* Fullscreen below sm -- a recipe is a focused, content-heavy task
          (ingredients + full step list), not a quick glance, so it gets the
          same treatment as a native app's fullscreen sheet instead of a
          small card fighting the actual viewport for room (live-confirmed
          2026-08-13: the old centered-card layout left the hero image
          eating a third of a 390px-wide screen before the title was even
          reached). Desktop/tablet keep the original centered-card look. */}
      <div
        className="flex h-full w-full flex-col overflow-hidden bg-surface sm:h-auto sm:max-h-[85dvh] sm:max-w-lg sm:rounded-2xl sm:shadow-[var(--shadow-lift)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button lives in this shrink-0 (non-scrolling) region so it
            stays reachable no matter how far the ingredients/instructions
            below are scrolled -- previously it sat next to the title inside
            the scrollable area and scrolled out of reach on any recipe with
            more than a couple of steps. */}
        <div className="relative shrink-0">
          {slot.imageUrl ? (
            <div className="aspect-21/9 w-full bg-paper-sunken sm:aspect-16/9">
              {/* eslint-disable-next-line @next/next/no-img-element -- external Spoonacular CDN, same as the card thumbnail above */}
              <img src={slot.imageUrl} alt={slot.recipeTitle} className="h-full w-full object-cover" />
            </div>
          ) : slot.aiComposed ? (
            <div className="aspect-21/9 w-full sm:aspect-16/9">
              <ComposedDishPlaceholder
                recipeTitle={slot.recipeTitle}
                proteinG={slot.proteinG}
                carbsG={slot.carbsG}
                fatG={slot.fatG}
              />
            </div>
          ) : (
            <div className="h-12 w-full bg-paper-sunken" />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-base font-semibold text-white backdrop-blur-sm transition-colors hover:bg-black/60"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          <h2 className="font-display text-lg font-bold text-foreground">{slot.recipeTitle}</h2>

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
              <ul className="mt-2 flex flex-col gap-0.5">
                {slot.recipeIngredients.map((ing, i) => (
                  <IngredientRow key={i} checked={checkedIngredients.has(i)} onToggle={() => toggleIngredient(i)}>
                    {formatIngredientAmount(ing.amount, ing.unit)} {ing.name}
                  </IngredientRow>
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
              <ul className="mt-2 flex flex-col gap-0.5">
                {slot.composedIngredients.map((ing, i) => (
                  <IngredientRow key={i} checked={checkedIngredients.has(i)} onToggle={() => toggleIngredient(i)}>
                    {Math.round(ing.amountG)}g {ing.name}
                  </IngredientRow>
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
              <ol className="mt-2 flex flex-col text-[15px] leading-relaxed text-foreground">
                {instructions.steps.map((step, i) => (
                  <li
                    key={i}
                    className={`flex gap-3 py-3 ${i > 0 ? "border-t border-border" : ""}`}
                  >
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-xs font-bold text-accent">
                      {i + 1}
                    </span>
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
    </div>,
    document.body,
  );
}

// Tappable/clickable while actually cooking -- crossing an ingredient off as
// you measure it out is the standard pattern real recipe apps use; a flat
// unstyled list gave no way to track progress partway through a recipe.
function IngredientRow({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 -mx-1 hover:bg-paper-sunken">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
        />
        <span className={`font-mono text-sm ${checked ? "text-muted line-through" : "text-foreground"}`}>
          {children}
        </span>
      </label>
    </li>
  );
}
