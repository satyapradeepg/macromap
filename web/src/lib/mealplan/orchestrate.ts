// Epic E2 (F3) — orchestration: fires all 21 slot cascades concurrently
// (OQ7), resolves claims, spends the shared retry budget (exhaustion first,
// then per-day reconciliation), and persists the result. Framework-agnostic
// (no "use server", no cookies()) — called by src/app/plan/actions.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  allSlotIds,
  perMealTarget,
  allMealTypeTargets,
  proteinFloorViolations,
  PROTEIN_FLOOR_FRACTION,
  slotMechanism,
  weeklyTarget as computeWeeklyTarget,
  slotKey,
  mealTypeToSpoonacularType,
  MEALS_PER_WEEK,
  DAYS_PER_WEEK,
  type MealSlotId,
  type MacroTargets,
  type MealType,
} from "./targets";
import { resolveDiet, resolveIntolerances } from "./dietaryMapping";
import { classifyTier, type MacroBounds, type ToleranceTier } from "./tolerance";
import { rankCandidates, type PantryItem, type RecipeCandidate, type RankedCandidate } from "./ranking";
import { runCascadeForSlot, matchLabelFor, type FetchCandidatesFn } from "./cascade";
import { createRetryBudget, trySpend, RECIPE_ACTION_COST, ADDON_ATTEMPT_COST } from "./retryBudget";
import { resolveClaims, type ClaimedSlot } from "./claim";
import {
  toleranceBand,
  sumActuals,
  macroGapDirections,
  isWithinBand,
  dominantDirection,
  dominantIncreaseGap,
  pickSlackSlots,
  nudgedBounds,
  type MacroGapDirection,
} from "./reconciliation";
import { buildAddonForSlot, type SlotAddon, type IngredientMacroLookup, type FetchIngredientMacrosFn } from "./addon";
import { composeSnack, composedSnackTitle, allPoolIngredientNames } from "./snackComposition";
import { lookupIngredientMacrosStatic } from "./staticIngredientMacros";
import { recipeCacheKey, isStale } from "./cacheKey";
import {
  complexSearch,
  lookupIngredientMacros,
  SpoonacularQuotaError,
  SpoonacularRequestError,
} from "@/lib/spoonacular";
import { createAdminClient } from "@/lib/supabase/admin";

export { SpoonacularQuotaError, SpoonacularRequestError };

// Shared across every retry/reconciliation phase below: a quota/outage
// error partway through generation should degrade whatever's affected to
// "blocked"/"not fully reconciled" and keep the rest of the plan, not
// discard everything already built. Anything else re-throws unchanged —
// only these two known, recoverable Spoonacular failure modes are handled
// this way.
function isRecoverableSpoonacularError(err: unknown): boolean {
  return err instanceof SpoonacularQuotaError || err instanceof SpoonacularRequestError;
}

const QUOTA_EXHAUSTED_HINT = "Generation temporarily unavailable for this meal — try again shortly.";

// Recomputed fresh from claimResult.claimed + the addons map every time,
// rather than incrementally tracked — sumActuals(claimResult.claimed) alone
// silently drops add-on macros whenever it's called again later (e.g. after
// phase 2's recipe swaps), which is exactly the kind of staleness bug this
// avoids by never trusting a previously-incremented running total.
// Shared between the main generation loop and swapSlotCandidate's
// composed-snack path (a "swap" on a snack recomposes with a different
// variety seed rather than a fresh Spoonacular search, which doesn't apply
// to snacks — see targets.ts's SLOT_MECHANISM). id must be unique within
// the caller's scope; negative so it never collides with a real
// (always-positive) Spoonacular recipe id.
function composedSnackCandidate(
  target: MacroTargets,
  pool: Record<string, { id: number; name: string; caloriesPer100g: number; proteinGPer100g: number; carbsGPer100g: number; fatGPer100g: number }>,
  varietySeed: number,
  id: number,
): RankedCandidate | null {
  const composed = composeSnack(target, pool, varietySeed);
  if (composed.ingredients.length === 0) return null;

  return {
    id,
    title: composedSnackTitle(composed),
    imageUrl: null,
    servings: 1,
    proteinG: composed.totalProteinG,
    caloriesKcal: composed.totalCalories,
    carbsG: composed.totalCarbsG,
    fatG: composed.totalFatG,
    pricePerServingCents: null,
    aggregateLikes: 0,
    ingredients: composed.ingredients.map((i) => ({
      id: i.spoonacularIngredientId,
      name: i.ingredientName,
      amount: i.amountG,
      unit: "g",
      metricAmount: i.amountG,
      metricUnit: "g",
    })),
    score: 0,
    budgetCompliant: true,
    // "p10" here means "composed directly to target," not a recipe-search
    // tolerance tier — matchLabelFor treats it the same as a clean match,
    // which is correct: composition doesn't have a "closest available"
    // tradeoff the way recipe search does.
    actualTier: "p10",
    isFallbackOfLastResort: false,
  };
}

// The 9 pool ingredients are a fixed, non-user-specific set (see
// staticIngredientMacros.ts) — reads from the pinned table instead of
// querying Spoonacular live on every generation/swap. Falls back to a real
// live lookup for any name the static table doesn't recognize (e.g. if
// INGREDIENT_POOL ever grows without the static table being refreshed) so
// results stay grounded in real data either way, never fabricated.
async function fetchSnackIngredientPool() {
  const poolEntries = await Promise.all(
    allPoolIngredientNames().map(async (name) => {
      const staticMatch = lookupIngredientMacrosStatic(name);
      if (staticMatch) return [name, staticMatch] as const;
      return [name, await lookupIngredientMacros(name)] as const;
    }),
  );
  return Object.fromEntries(
    poolEntries.filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null),
  );
}

// Same static-first, live-fallback pattern for addon.ts's fixed
// per-macro ingredient names (a subset of the same 9-ingredient pool) —
// used wherever an add-on lookup previously called lookupIngredientMacros
// directly.
const lookupIngredientMacrosForAddon: FetchIngredientMacrosFn = async (query: string): Promise<IngredientMacroLookup | null> => {
  const staticMatch = lookupIngredientMacrosStatic(query);
  if (staticMatch) return staticMatch;
  return lookupIngredientMacros(query);
};

function sumWithAddons(claimed: ClaimedSlot[], addons: Map<string, SlotAddon>): MacroTargets {
  let total = sumActuals(claimed);
  for (const addon of addons.values()) {
    total = {
      calories: total.calories + addon.caloriesKcal,
      proteinG: total.proteinG + addon.proteinG,
      carbsG: total.carbsG + addon.carbsG,
      fatG: total.fatG + addon.fatG,
    };
  }
  return total;
}

// All slots of the SAME meal type share an identical target (targets.ts's
// MEAL_TYPE_SHARE — breakfast/lunch/dinner now get different shares of the
// daily total, not an even 1/3 each), so each meal-type's query's
// candidate pool has to cover all its unique claims (7 breakfast claims,
// 14 lunch+dinner claims — meal-type realism, added in the Epic E2
// rework, splits what used to be ONE shared 21-slot pool into two:
// type=breakfast and type=main course, live-confirmed to return genuinely
// different, meal-appropriate results — see spoonacular.ts).
// cascade.ts now always fetches at the widest tier (p30) rather than only
// widening when the tightest tier is empty — verified live against
// Spoonacular: for an unrestricted 60g-protein/meal profile, p30 alone has
// 226 real matches (vs p10's 25), and only fetching the tightest tier left
// almost nothing for the carb/fat compliance preference to work with
// (1/25 vs 6/40 compliant). 60 gives real headroom over that wider
// population without over-fetching — still just ONE deduped call per
// unique (bounds, type, ...) query per generation. Kept the same for both
// meal-type pools for now rather than tuning breakfast's smaller 7-claim
// need separately — no live fill-rate data yet to justify a different
// number per type.
const CANDIDATES_PER_QUERY = 60;

export interface OrchestrateInput {
  userId: string;
  dailyTargets: MacroTargets;
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
  tier: "free" | "pro";
  weeklyBudgetUsd: number | null;
  pantryItems: PantryItem[];
}

export interface OrchestratedSlot {
  slotId: MealSlotId;
  candidate: ClaimedSlot["candidate"];
  tier: ToleranceTier;
  matchLabel: string | null;
  addon?: SlotAddon;
}

export interface OrchestrateResult {
  slots: OrchestratedSlot[];
  blockedSlots: Array<{ slotId: MealSlotId; blockingHint: string }>;
  reconciliationStatus: "within_band" | "outside_band_after_retries";
  retryQueriesUsed: number;
  weeklyTarget: MacroTargets;
  weeklyActual: MacroTargets;
}

export async function orchestrateGeneration(input: OrchestrateInput): Promise<OrchestrateResult> {
  const mealTypeTargets = allMealTypeTargets(input.dailyTargets);
  const weekly = computeWeeklyTarget(input.dailyTargets);

  const diet = resolveDiet(input.dietaryStyles);
  const intolerances = resolveIntolerances(input.dietaryStyles);
  const excludeIngredients = [...input.allergies, ...input.dislikes];
  const budgetPerMealUsd = input.weeklyBudgetUsd !== null ? input.weeklyBudgetUsd / MEALS_PER_WEEK : null;
  const rankOpts = { tier: input.tier, budgetPerMealUsd, pantryItems: input.pantryItems };

  const admin = createAdminClient();
  // All slots of the SAME meal type share an identical target, so at a
  // given tier they all compute the same cache key — without this,
  // Promise.all below would race N concurrent callers past a cold-cache
  // miss and each would fire its own real Spoonacular call for what should
  // be one shared request per meal type. Scoped to this one generation
  // call (not module-level) so it can't leak across requests/users.
  const inFlight = new Map<string, Promise<RecipeCandidate[]>>();

  const makeFetcher = (excludeIds: number[], type: string): FetchCandidatesFn => (bounds, tier) =>
    fetchCandidatesWithCache(admin, { bounds, tier, diet, intolerances, excludeIngredients, type }, excludeIds, inFlight);

  // Only breakfast/lunch/dinner use recipe search — snacks are built
  // separately below via ingredient composition (slotMechanism, see
  // targets.ts/snackComposition.ts for why recipe search is the wrong tool
  // for snacks).
  const allSlots = allSlotIds();
  const recipeSlotIds = allSlots.filter((s) => slotMechanism(s.mealType) === "recipe");
  const snackSlotIds = allSlots.filter((s) => slotMechanism(s.mealType) === "composed");

  // allSettled, not all — a Spoonacular outage/quota exhaustion on ONE
  // slot's cascade used to reject the whole batch and abort generation
  // entirely (the exact failure mode hit live July 15 2026: a single
  // downstream 402 discarded every already-successful slot). A recoverable
  // Spoonacular error now degrades that one slot to blocked instead of
  // failing the entire plan; anything else (a real bug) still throws.
  const cascadeSettled = await Promise.allSettled(
    recipeSlotIds.map((slotId) =>
      runCascadeForSlot(
        mealTypeTargets[slotId.mealType],
        makeFetcher([], mealTypeToSpoonacularType(slotId.mealType)),
        rankOpts,
      ),
    ),
  );
  const cascades = cascadeSettled.map((settled) => {
    if (settled.status === "fulfilled") return settled.value;
    if (!isRecoverableSpoonacularError(settled.reason)) throw settled.reason;
    return { rankedCandidates: [], blocked: true, blockingHint: QUOTA_EXHAUSTED_HINT };
  });

  const claimResult = resolveClaims(recipeSlotIds.map((slotId, i) => ({ slotId, cascade: cascades[i] })));
  const blockedHints = new Map<string, string>();
  for (const slotId of claimResult.blockedSlots) {
    const cascade = cascades[recipeSlotIds.findIndex((s) => slotKey(s) === slotKey(slotId))];
    blockedHints.set(slotKey(slotId), cascade.blockingHint ?? "No recipe matched this meal's targets.");
  }

  // Own small budget, separate from each day's reconciliation budget below —
  // exhaustion is rare (claim-resolution collisions across 21 slots), so
  // this shouldn't compete with every day's macro gap-closing for the same
  // pool (see the per-day budget note further down for why that matters).
  const exhaustionBudget = createRetryBudget();
  let retryQueriesUsed = 0;

  // Exhaustion re-queries first (rare) — one attempt each, excluding every
  // recipe already claimed elsewhere in this plan. A quota/outage error
  // here stops further exhaustion retries (every remaining attempt would
  // fail the same way) but keeps everything claimed so far — degrades to
  // "blocked" for whatever's left, not a whole-plan failure.
  for (const slotId of claimResult.exhaustedSlots) {
    if (!trySpend(exhaustionBudget, RECIPE_ACTION_COST)) break;
    retryQueriesUsed++;
    const claimedIds = claimResult.claimed.map((c) => c.candidate.id);
    let cascade;
    try {
      cascade = await runCascadeForSlot(
        mealTypeTargets[slotId.mealType],
        makeFetcher(claimedIds, mealTypeToSpoonacularType(slotId.mealType)),
        rankOpts,
      );
    } catch (err) {
      if (!isRecoverableSpoonacularError(err)) throw err;
      blockedHints.set(slotKey(slotId), QUOTA_EXHAUSTED_HINT);
      break;
    }
    if (!cascade.blocked && cascade.rankedCandidates.length > 0) {
      const pick = cascade.rankedCandidates[0];
      claimResult.claimed.push({ slotId, candidate: pick, tier: pick.actualTier ?? "p30" });
    } else {
      blockedHints.set(
        slotKey(slotId),
        cascade.blockingHint ?? "Every close match for this meal is already used elsewhere this week.",
      );
    }
  }

  // Snack slots (snack1/snack2): composed from a small ingredient pool
  // fetched ONCE here and reused for all 14 snack slots this week — a
  // fresh 2-3 lookup per slot would cost ~84 Spoonacular points/plan (3
  // lookups x 2pts x 14 slots); fetching the fixed 9-ingredient pool once
  // costs ~18 points regardless of how many snack slots use it. This is a
  // real, permanent addition to baseline per-plan cost (every plan now has
  // 14 snack slots), not a rare reconciliation-only cost.
  const snackIngredientPool = await fetchSnackIngredientPool();

  let syntheticSnackId = -1;
  for (const slotId of snackSlotIds) {
    // Rotates which pool ingredient each snack slot uses (dayIndex x slot
    // position) so a week's 14 snacks aren't all identical — deterministic,
    // not Math.random, matching this pipeline's determinism elsewhere.
    const varietySeed = slotId.dayIndex * 2 + (slotId.mealType === "snack1" ? 0 : 1);
    const candidate = composedSnackCandidate(
      mealTypeTargets[slotId.mealType],
      snackIngredientPool,
      varietySeed,
      syntheticSnackId--,
    );

    if (!candidate) {
      blockedHints.set(slotKey(slotId), "Couldn't compose a snack close to this meal's targets.");
      continue;
    }
    claimResult.claimed.push({ slotId, candidate, tier: "p10" });
  }

  // Daily reconciliation (reworked from weekly-only — a plan can look fine
  // on a whole-week average while individual days swing wildly; Prospre-
  // style plans reconcile per day). Runs once per day, days 0-6 in order.
  //
  // Each day gets its OWN fresh retry budget (PRD F3 backlog item, closed
  // July 2026) rather than all 7 days sharing one pool — the shared-pool
  // design dated back to when reconciliation was a single weekly pass (the
  // budget's own default sizing, retryBudget.ts, was never rescaled when
  // reconciliation moved to per-day), and in practice let day 0 (processed
  // first) consume most of the budget, leaving later days with little or
  // no gap-closing help. Giving every day the same starting allowance means
  // day 6 gets the same shot at hitting its band as day 0. Each day's pass
  // has the same two phases as before, just scoped to that day's 3 slots
  // and its own daily target instead of all 21 slots and the weekly target:
  //
  // 1. Snack/add-on gap-closer (F3, tried first) — an add-on can only ever
  //    ADD macros, so it's only useful for "increase" gaps (this day's
  //    actual too low); a "decrease" gap (too high) skips straight to
  //    phase 2. Sized to the slot's own 20%-of-calories cap (addon.ts), so
  //    one attempt rarely closes a whole day's gap by itself — the loop
  //    keeps attaching add-ons to different slack slots within this same
  //    day (never the same slot twice) until the gap closes or the budget
  //    runs out.
  // 2. Full recipe requery (single targeted re-fetch per slack slot rather
  //    than a fresh 3-tier cascade) — for whatever's left in this day
  //    after phase 1, on both remaining "increase" gaps and any "decrease"
  //    gaps. Slots already given an add-on this day are excluded here, so
  //    a slot never gets both an add-on and a full recipe swap in the same
  //    pass (would leave a stale, no-longer-relevant add-on attached to a
  //    newly-swapped recipe). Requeries a slot's own meal-type pool
  //    (mealTypeToSpoonacularType), not a shared one.
  //
  // A day within its own ±5% band on all 7 days mathematically guarantees
  // the weekly sum is within ±5% of the weekly target too (each day's
  // actual sits inside [0.95, 1.05] x its own daily target, so the sum of
  // 7 such days sits inside the same multiple of the summed target) — so
  // there's no separate weekly check needed on top of this.
  const dailyBand = toleranceBand(input.dailyTargets);
  const addons = new Map<string, SlotAddon>();
  const dailyStatuses: Array<"within_band" | "outside_band_after_retries"> = [];

  for (let dayIndex = 0; dayIndex < DAYS_PER_WEEK; dayIndex++) {
    const daySlots = () => claimResult.claimed.filter((c) => c.slotId.dayIndex === dayIndex);
    const addonedThisDay = new Set<string>();
    // Fresh per-day budget (see the comment above the loop) — not shared
    // with any other day, only with this day's own protein-floor
    // enforcement pass further down.
    const dayRetryBudget = createRetryBudget();

    // Whole day wrapped in one try/catch: a quota/outage error can surface
    // from several calls below (add-on lookups, recipe requeries). If it's
    // one of those two known-recoverable Spoonacular error types, every
    // subsequent day would fail identically (quota doesn't come back
    // mid-request), so this stops the whole reconciliation loop here —
    // whatever's already claimed/added-on (including partial progress
    // earlier in THIS day, before the throw) is kept as-is, and this day
    // plus every remaining day is honestly marked as not fully
    // reconciled, rather than discarding the whole plan (the failure mode
    // hit live July 15 2026).
    try {
      let gaps = macroGapDirections(sumWithAddons(daySlots(), addons), dailyBand);
      let increaseGap = dominantIncreaseGap(gaps);
      while (increaseGap && trySpend(dayRetryBudget, ADDON_ATTEMPT_COST)) {
        retryQueriesUsed++;

        const eligible = daySlots().filter((c) => !addonedThisDay.has(slotKey(c.slotId)));
        const [targetSlotId] = pickSlackSlots(eligible, mealTypeTargets, [increaseGap], 1);
        if (!targetSlotId) break; // no slot left in this day to try an add-on on

        const existing = claimResult.claimed.find((c) => slotKey(c.slotId) === slotKey(targetSlotId));
        if (!existing) break;

        const addon = await buildAddonForSlot(existing.candidate.caloriesKcal, increaseGap, lookupIngredientMacrosForAddon);
        addonedThisDay.add(slotKey(targetSlotId));
        if (addon) {
          addons.set(slotKey(targetSlotId), addon);
        }
        // If no addon was returned (ingredient unresolved or too small to
        // matter), the slot is still marked addonedThisDay so the next
        // iteration tries a different slot rather than repeating the same
        // failure — never fakes progress that didn't happen.

        gaps = macroGapDirections(sumWithAddons(daySlots(), addons), dailyBand);
        increaseGap = dominantIncreaseGap(gaps);
      }

      if (gaps.length > 0) {
        const direction = dominantDirection(gaps)!;
        // Recipe requery only applies to recipe-mechanism slots — a composed
        // snack has no Spoonacular recipe to "requery" (mealTypeToSpoonacularType
        // throws for snack types); a snack with remaining slack only gets
        // helped by phase 1's add-on, not this phase.
        const eligible = daySlots().filter(
          (c) => !addonedThisDay.has(slotKey(c.slotId)) && slotMechanism(c.slotId.mealType) === "recipe",
        );
        const affordableRequeries = Math.floor(dayRetryBudget.remaining / RECIPE_ACTION_COST);
        const slackSlotIds = pickSlackSlots(eligible, mealTypeTargets, gaps, affordableRequeries);

        for (const slotId of slackSlotIds) {
          if (!trySpend(dayRetryBudget, RECIPE_ACTION_COST)) break;
          retryQueriesUsed++;

          const existingIndex = claimResult.claimed.findIndex((c) => slotKey(c.slotId) === slotKey(slotId));
          if (existingIndex === -1) continue;
          const existing = claimResult.claimed[existingIndex];

          const claimedIds = claimResult.claimed
            .filter((_, i) => i !== existingIndex)
            .map((c) => c.candidate.id);
          const slotTarget = mealTypeTargets[slotId.mealType];
          const bounds = nudgedBounds(slotTarget, direction);
          const raw = await fetchCandidatesWithCache(
            admin,
            // Reconciliation's nudge doesn't correspond to a named p10/p20/p30
            // tier — reuse the slot's own original tier purely as a label for
            // the cache row's informational tolerance_tier column.
            { bounds, tier: existing.tier, diet, intolerances, excludeIngredients, type: mealTypeToSpoonacularType(slotId.mealType) },
            claimedIds,
            inFlight,
          );
          const ranked = rankCandidates(raw, slotTarget, rankOpts);
          const pick = ranked.find((c) => !claimedIds.includes(c.id));
          if (pick) {
            // The nudge intentionally searches outside the slot's original
            // tier — recompute the pick's real tier against the true per-meal
            // target (not the nudged one) so the persisted label/match_label
            // honestly reflects it, rather than carrying over a stale tier
            // that no longer matches the actual deviation.
            const actualTier = classifyTier(pick, slotTarget) ?? "p30";
            claimResult.claimed[existingIndex] = { slotId, candidate: pick, tier: actualTier };
          }
          // If nothing found, leave the existing claim unchanged — the gap
          // simply isn't closed for that slot (never fakes an exact match).
        }
      }

      // Protein-distribution enforcement (targets.ts's proteinFloorViolations)
      // — previously monitoring-only (PRD F3 backlog item, closed July 2026).
      // Runs after the day-aggregate gap-closing phases above so it sees
      // their final picks (an add-on/swap from phase 1/2 may have already
      // pushed a flagged meal back over its floor). Still doesn't touch
      // ranking/candidate order itself (targets.ts's comment on why a hard
      // ranking constraint risks reintroducing the breakfast corpus-scarcity
      // problem still holds) — this only spends budget on a targeted top-up
      // for whichever specific meal is under floor, same "never fake
      // progress" discipline as phases 1/2.
      const currentMealProtein = () =>
        daySlots().map((c) => ({
          mealType: c.slotId.mealType,
          proteinG: c.candidate.proteinG + (addons.get(slotKey(c.slotId))?.proteinG ?? 0),
        }));

      for (const mealType of proteinFloorViolations(input.dailyTargets.proteinG, currentMealProtein())) {
        const slotId = daySlots().find((c) => c.slotId.mealType === mealType)?.slotId;
        if (!slotId) continue;
        const proteinFloor = input.dailyTargets.proteinG * PROTEIN_FLOOR_FRACTION;
        const floorGap: MacroGapDirection = { macro: "proteinG", direction: "increase", overshootPct: 1 };

        // Prefer an add-on (protein powder/yogurt) — but PRD F3 caps one
        // add-on per slot for realism, so only attempt this if phases 1/2
        // above didn't already attach one to this exact slot.
        if (!addonedThisDay.has(slotKey(slotId)) && trySpend(dayRetryBudget, ADDON_ATTEMPT_COST)) {
          retryQueriesUsed++;
          const existing = claimResult.claimed.find((c) => slotKey(c.slotId) === slotKey(slotId));
          addonedThisDay.add(slotKey(slotId));
          if (existing) {
            const addon = await buildAddonForSlot(existing.candidate.caloriesKcal, floorGap, lookupIngredientMacrosForAddon);
            if (addon) addons.set(slotKey(slotId), addon);
          }
        }

        // Re-check after the add-on attempt (or immediately, if this slot
        // already had one from phases 1/2 and so was skipped above) — only
        // fall through to a recipe swap if still genuinely under floor, and
        // only for recipe-mechanism slots (snacks have no Spoonacular recipe
        // to requery, same constraint as phase 2).
        const existingNow = claimResult.claimed.find((c) => slotKey(c.slotId) === slotKey(slotId));
        const proteinNow = (existingNow?.candidate.proteinG ?? 0) + (addons.get(slotKey(slotId))?.proteinG ?? 0);
        if (existingNow && proteinNow < proteinFloor && slotMechanism(mealType) === "recipe" && trySpend(dayRetryBudget, RECIPE_ACTION_COST)) {
          retryQueriesUsed++;
          const claimedIds = claimResult.claimed
            .filter((c) => slotKey(c.slotId) !== slotKey(slotId))
            .map((c) => c.candidate.id);
          const slotTarget = mealTypeTargets[mealType];
          const bounds = nudgedBounds(slotTarget, "increase");
          const raw = await fetchCandidatesWithCache(
            admin,
            { bounds, tier: existingNow.tier, diet, intolerances, excludeIngredients, type: mealTypeToSpoonacularType(mealType) },
            claimedIds,
            inFlight,
          );
          const ranked = rankCandidates(raw, slotTarget, rankOpts);
          // Requires a real protein improvement over the current pick — a
          // swap that doesn't actually raise protein isn't worth spending
          // budget on (would just repeat the same violation next generation).
          const pick = ranked.find((c) => !claimedIds.includes(c.id) && c.proteinG > existingNow.candidate.proteinG);
          if (pick) {
            const actualTier = classifyTier(pick, slotTarget) ?? "p30";
            const idx = claimResult.claimed.findIndex((c) => slotKey(c.slotId) === slotKey(slotId));
            claimResult.claimed[idx] = { slotId, candidate: pick, tier: actualTier };
            // The old add-on (if any) was sized against the pre-swap recipe's
            // calories and is no longer relevant to the newly-picked one.
            addons.delete(slotKey(slotId));
          }
        }
      }

      const dayFinalActual = sumWithAddons(daySlots(), addons);
      dailyStatuses.push(isWithinBand(dayFinalActual, dailyBand) ? "within_band" : "outside_band_after_retries");

      const remainingViolations = proteinFloorViolations(input.dailyTargets.proteinG, currentMealProtein());
      if (remainingViolations.length > 0) {
        console.log(`[mealplan] day ${dayIndex}: protein floor violation persisted after enforcement in ${remainingViolations.join(", ")}`);
      }
    } catch (err) {
      if (!isRecoverableSpoonacularError(err)) throw err;
      console.error(
        `[mealplan] day ${dayIndex}: reconciliation stopped early (Spoonacular quota/outage) — keeping the plan built so far`,
        err,
      );
      for (let remaining = dayIndex; remaining < DAYS_PER_WEEK; remaining++) {
        dailyStatuses.push("outside_band_after_retries");
      }
      break;
    }
  }

  // Weekly totals are still computed and returned for the plan-level
  // summary display, but the pass/fail signal now comes from every day
  // individually passing (see the daily loop above), not from this sum.
  const actual = sumWithAddons(claimResult.claimed, addons);
  const reconciliationStatus = dailyStatuses.every((s) => s === "within_band")
    ? "within_band"
    : "outside_band_after_retries";

  const slots: OrchestratedSlot[] = claimResult.claimed.map((c) => ({
    slotId: c.slotId,
    candidate: c.candidate,
    tier: c.tier,
    matchLabel: matchLabelFor(c.tier, c.candidate, mealTypeTargets[c.slotId.mealType]),
    addon: addons.get(slotKey(c.slotId)),
  }));

  const blockedSlots = [...blockedHints.entries()].map(([key, blockingHint]) => ({
    slotId: allSlots.find((s) => slotKey(s) === key)!,
    blockingHint,
  }));

  console.log(
    `[mealplan] generation done: ${slots.length}/${MEALS_PER_WEEK} claimed, ${blockedSlots.length} blocked, ` +
      `retryQueriesUsed=${retryQueriesUsed}, reconciliation=${reconciliationStatus}`,
  );

  return {
    slots,
    blockedSlots,
    reconciliationStatus,
    retryQueriesUsed,
    weeklyTarget: weekly,
    weeklyActual: actual,
  };
}

interface CacheableQuery {
  bounds: MacroBounds;
  // Not part of the cache key (bounds already fully determine the query) —
  // carried through purely to label the cache row's informational
  // tolerance_tier column (NOT NULL with a check constraint).
  tier: ToleranceTier;
  diet: string | undefined;
  intolerances: string[];
  excludeIngredients: string[];
  // Meal-type realism — IS part of the cache key (see cacheKey.ts):
  // breakfast and main course return genuinely different result sets.
  type: string;
}

// Cache key deliberately excludes excludeIds (per-user) — fetched/cached
// candidates are the shared pool; excludeIds is applied client-side after
// every read, whether from cache or from a fresh Spoonacular call.
async function fetchCandidatesWithCache(
  admin: SupabaseClient,
  query: CacheableQuery,
  excludeIds: number[],
  inFlight: Map<string, Promise<RecipeCandidate[]>>,
): Promise<RecipeCandidate[]> {
  const raw = await fetchRawCandidates(admin, query, inFlight);
  const exclude = new Set(excludeIds);
  return raw.filter((c) => !exclude.has(c.id));
}

// De-duplicates concurrent callers requesting the same (bounds, diet,
// intolerances, excludeIngredients) tuple — without this, N concurrent
// slots with an identical query would each independently race the cache
// read and each fire its own Spoonacular call on a cold cache.
async function fetchRawCandidates(
  admin: SupabaseClient,
  query: CacheableQuery,
  inFlight: Map<string, Promise<RecipeCandidate[]>>,
): Promise<RecipeCandidate[]> {
  const cacheKey = recipeCacheKey({
    minProtein: query.bounds.minProtein,
    maxProtein: query.bounds.maxProtein,
    minCalories: query.bounds.minCalories,
    maxCalories: query.bounds.maxCalories,
    diet: query.diet,
    intolerances: query.intolerances,
    excludeIngredients: query.excludeIngredients,
    resultCount: CANDIDATES_PER_QUERY,
    type: query.type,
  });

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    const { data: cached } = await admin
      .from("recipe_query_cache")
      .select("candidates, fetched_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (cached && !isStale(new Date(cached.fetched_at))) {
      return cached.candidates as RecipeCandidate[];
    }

    const fresh = await complexSearch({
      bounds: query.bounds,
      diet: query.diet,
      intolerances: query.intolerances,
      excludeIngredients: query.excludeIngredients,
      excludeIds: [], // never let per-user exclusion leak into the cached pool
      number: CANDIDATES_PER_QUERY,
      type: query.type,
    });

    console.log(
      `[mealplan] fetched ${fresh.length} raw candidates from Spoonacular ` +
        `(bounds=${JSON.stringify(query.bounds)}, diet=${query.diet ?? "none"}, type=${query.type})`,
    );

    await admin.from("recipe_query_cache").upsert(
      {
        cache_key: cacheKey,
        tolerance_tier: query.tier,
        params: query,
        candidates: fresh,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "cache_key" },
    );

    return fresh;
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

// Swap-meal (F3): single-slot re-cascade excluding every recipe currently
// claimed in the plan (including this slot's own), no weekly reconciliation
// re-run — a single swap shouldn't trigger several more Spoonacular calls.
export interface SwapSlotInput {
  dailyTargets: MacroTargets;
  mealType: MealType;
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
  tier: "free" | "pro";
  weeklyBudgetUsd: number | null;
  excludeRecipeIds: number[];
  pantryItems: PantryItem[];
}

export interface SwapSlotResult {
  candidate: ClaimedSlot["candidate"] | null;
  tier: ToleranceTier | null;
  matchLabel: string | null;
  blocked: boolean;
  blockingHint: string | null;
}

export async function swapSlotCandidate(input: SwapSlotInput): Promise<SwapSlotResult> {
  const perMeal = perMealTarget(input.dailyTargets, input.mealType);

  // Snacks have no Spoonacular recipe to requery — "swap" recomposes with a
  // different pool option instead (3 possible combos per role, same pool
  // size as generation's rotation). fetchSnackIngredientPool() reads the
  // pinned static table (staticIngredientMacros.ts), so this is ~free, not
  // the ~18pt live re-fetch this comment used to describe.
  if (slotMechanism(input.mealType) === "composed") {
    const pool = await fetchSnackIngredientPool();
    const varietySeed = Date.now() % 3;
    const candidate = composedSnackCandidate(perMeal, pool, varietySeed, -1);
    if (!candidate) {
      return {
        candidate: null,
        tier: null,
        matchLabel: null,
        blocked: true,
        blockingHint: "Couldn't compose an alternative snack for this meal's targets.",
      };
    }
    return { candidate, tier: "p10", matchLabel: null, blocked: false, blockingHint: null };
  }

  const diet = resolveDiet(input.dietaryStyles);
  const intolerances = resolveIntolerances(input.dietaryStyles);
  const excludeIngredients = [...input.allergies, ...input.dislikes];
  const budgetPerMealUsd = input.weeklyBudgetUsd !== null ? input.weeklyBudgetUsd / MEALS_PER_WEEK : null;

  const admin = createAdminClient();
  const inFlight = new Map<string, Promise<RecipeCandidate[]>>();
  const fetcher: FetchCandidatesFn = (bounds, tier) =>
    fetchCandidatesWithCache(
      admin,
      { bounds, tier, diet, intolerances, excludeIngredients, type: mealTypeToSpoonacularType(input.mealType) },
      input.excludeRecipeIds,
      inFlight,
    );

  const cascade = await runCascadeForSlot(perMeal, fetcher, {
    tier: input.tier,
    budgetPerMealUsd,
    pantryItems: input.pantryItems,
  });
  if (cascade.blocked || cascade.rankedCandidates.length === 0) {
    return {
      candidate: null,
      tier: null,
      matchLabel: null,
      blocked: true,
      blockingHint: cascade.blockingHint ?? "No alternative recipe matched this meal's targets.",
    };
  }

  const pick = cascade.rankedCandidates[0];
  const actualTier = pick.actualTier ?? "p30";
  return {
    candidate: pick,
    tier: actualTier,
    matchLabel: matchLabelFor(actualTier, pick, perMeal),
    blocked: false,
    blockingHint: null,
  };
}
