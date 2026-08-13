"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import type { MealType } from "@/lib/mealplan/targets";
import { prepNoteFor } from "@/lib/mealplan/staticIngredientMacros";
import type { PlanSlotView } from "./data";
import { pickDishIcon, type DishIconKind } from "./dishIcon";
import { RecipeModal } from "./RecipeModal";

// Extracted from PlanView.tsx's inline MealCard/ComposedDishPlaceholder/
// MacroPill (2026-08-10 redesign). All slot-shaping logic (hasRecipeDetail,
// showPlaceholderImage, composedSnackFooter, formatServings) is unchanged
// byte-for-byte -- only the JSX/styling changed. RecipeModal now lives in
// its own file and is imported here instead of being defined below it.

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
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
export function formatServings(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded} ${rounded === 1 ? "serving" : "servings"}`;
}

// Each pool ingredient's own prep note (if any) is now rendered inline next
// to that ingredient (see the composedIngredients list below), not dumped
// into a single bottom-of-card line -- with oats/edamame added to the pool
// (2026-07-30) a snack can have TWO ingredients that each carry a note
// (e.g. "10g oats — cook with water as oatmeal" AND "15g hemp seeds —
// sprinkle over the oats"), so a footer that could only surface one note
// silently dropped the other. This footer is only the true "nothing needs
// prep" fallback -- must NOT fire when any ingredient already has a note.
export function composedSnackFooter(ingredients: PlanSlotView["composedIngredients"]): string {
  const list = ingredients ?? [];
  const anyNote = list.some((ingredient, i) => {
    const otherNames = list.filter((_, j) => j !== i).map((o) => o.name);
    return prepNoteFor(ingredient.name, "snack", otherNames) !== null;
  });
  return anyNote ? "" : "Combine and eat — no cooking";
}

type PillTone = "neutral" | "protein" | "carbs" | "fat";

const PILL_TONE_CLASSES: Record<PillTone, string> = {
  neutral: "border border-border text-muted",
  protein: "bg-protein-tint text-protein",
  carbs: "bg-carbs-tint text-carbs",
  fat: "bg-fat-tint text-fat",
};

// Color-coded by macro type (2026-08-10 redesign) so protein/carbs/fat are
// recognizable at a glance, not just distinguishable by reading the unit
// label -- previously every pill (cal/protein/carbs/fat/servings) used the
// same flat neutral style.
export function MacroPill({ children, tone = "neutral" }: { children: ReactNode; tone?: PillTone }) {
  return (
    <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${PILL_TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

// Placeholder for an AI-composed dish, which never has a real photo (2026-
// 07-30 UI pass). A plain stroke icon, not a color emoji, to stay
// monochrome/muted-toned like this app's other glyphs (✕/●/↗) rather than
// introducing a jarring colorful element. Picks one of a small set of
// dish-shape icons via a keyword match on the AI-generated title
// (pickDishIcon, dishIcon.ts) instead of always showing the same bowl.
//
// 2026-08-10 redesign: background is now tinted toward whichever macro
// (protein/carbs/fat) is dominant in the dish, computed from the slot's
// own real macro grams -- not a decorative/arbitrary color, an actual
// signal about what the dish is macro-heavy in, consistent with the
// macro-ring/pill color coding used everywhere else in the redesign.
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

function dominantMacroTint(proteinG: number, carbsG: number, fatG: number): { bg: string; fg: string } {
  const top = Math.max(proteinG, carbsG, fatG);
  if (top === proteinG) return { bg: "var(--protein-tint)", fg: "var(--protein)" };
  if (top === carbsG) return { bg: "var(--carbs-tint)", fg: "var(--carbs)" };
  return { bg: "var(--fat-tint)", fg: "var(--fat)" };
}

export function ComposedDishPlaceholder({
  recipeTitle,
  proteinG,
  carbsG,
  fatG,
}: {
  recipeTitle: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
}) {
  const tint = dominantMacroTint(proteinG, carbsG, fatG);
  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{ background: `linear-gradient(150deg, ${tint.bg}, var(--paper-sunken))`, color: tint.fg }}
    >
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {DISH_ICON_PATHS[pickDishIcon(recipeTitle)]}
      </svg>
    </div>
  );
}

export function MealCard({
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
  const hasPhotoArea = !!slot?.imageUrl || showPlaceholderImage;
  const totalCal = slot ? Math.round(slot.calories + (slot.addon?.caloriesKcal ?? 0)) : 0;

  // An unfilled slot previously shared the exact same solid-border card
  // chrome as a real, filled meal -- next to 1-2 fully-photographed
  // neighbors in the same grid row it read as broken rather than
  // intentionally "nothing matched here" (design review 2026-08-13). Dashed
  // border + slightly sunken background gives it its own honest, designed
  // empty-state look instead of looking like a rendering failure.
  const isEmptySlot = !slot || slot.isUnfilled;

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-2xl shadow-[var(--shadow-card)] transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)] motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${
        isEmptySlot ? "border border-dashed border-border bg-paper-sunken" : "border border-border bg-surface"
      }`}
    >
      {hasPhotoArea && (
        <div className="relative aspect-4/3 w-full shrink-0 bg-paper-sunken">
          {slot?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- external Spoonacular CDN, not worth a next.config remotePatterns entry for a thumbnail
            <img src={slot.imageUrl} alt={slot.recipeTitle} loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <ComposedDishPlaceholder
              recipeTitle={slot!.recipeTitle}
              proteinG={slot!.proteinG}
              carbsG={slot!.carbsG}
              fatG={slot!.fatG}
            />
          )}
          {slot && !slot.isUnfilled && (
            <span className="absolute right-3 -bottom-3.5 flex items-baseline gap-1 rounded-full border border-border bg-surface px-3 py-1 shadow-[var(--shadow-card)]">
              <span className="font-mono text-sm font-bold tabular-nums">{totalCal}</span>
              <span className="font-mono text-[10px] text-muted">cal</span>
            </span>
          )}
        </div>
      )}
      <div className={`flex flex-1 flex-col p-3 ${hasPhotoArea ? "pt-5" : ""}`}>
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">{MEAL_TYPE_LABELS[mealType]}</p>

        {slot && !slot.isUnfilled ? (
          <>
            <p className="font-display mt-1 text-sm font-bold text-foreground">{slot.recipeTitle}</p>
            {/* slot.matchLabel ("Approximate...", "Closest match...", "Closest
                to your budget...") is deliberately not rendered -- surfacing
                match-quality/approximation caveats read as alarming or
                confusing on a meal card rather than useful, per Satya
                2026-08-01. Still computed/stored (matchLabelFor, orchestrate.ts)
                for internal use (ranking, ops debugging via the MCP route). */}

            <div className="mt-2 flex flex-wrap gap-1.5">
              <MacroPill>{totalCal} cal</MacroPill>
              <MacroPill tone="protein">{Math.round(slot.proteinG + (slot.addon?.proteinG ?? 0))}g protein</MacroPill>
              <MacroPill tone="carbs">{Math.round(slot.carbsG + (slot.addon?.carbsG ?? 0))}g carbs</MacroPill>
              <MacroPill tone="fat">{Math.round(slot.fatG + (slot.addon?.fatG ?? 0))}g fat</MacroPill>
            </div>

            {slot.isComposed ? (
              slot.composedIngredients && (
                // Collapsed by default (2026-08-10 redesign) -- a composed
                // dish's ingredient list can run 10+ lines (spices included),
                // which previously made every composed card a wall of text.
                // The addon note and composedSnackFooter below stay OUTSIDE
                // this disclosure, always visible, since they're not part of
                // "the ingredient list," they're a separate callout.
                <details className="mt-2 group">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-accent">
                    Ingredients ({slot.composedIngredients.length})
                    <span className="text-[10px] transition-transform group-open:rotate-180">▾</span>
                  </summary>
                  <div className="mt-1.5 space-y-0.5">
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
                        <p key={`${ingredient.name}-${i}`} className="font-mono text-xs text-muted">
                          {`${Math.round(ingredient.amountG)}g ${ingredient.name}`}
                          {note ? ` — ${note}` : ""}
                        </p>
                      );
                    })}
                  </div>
                </details>
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
          //
          // Icon matches ComposedDishPlaceholder's stroke convention below
          // (viewBox 0 0 24 24, currentColor, strokeWidth 1.5) rather than
          // introducing a new visual language just for this one state.
          <div className="mt-3 flex flex-col items-center gap-2 py-4 text-center">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M9 9l6 6M15 9l-6 6" />
            </svg>
            <p className="text-xs text-muted">
              {slot?.isUnfilled ? slot.recipeTitle : (blockingHint ?? "No recipe matched this meal yet.")}
            </p>
          </div>
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
