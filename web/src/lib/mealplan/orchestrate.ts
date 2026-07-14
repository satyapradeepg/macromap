// Epic E2 (F3) — orchestration: fires all 21 slot cascades concurrently
// (OQ7), resolves claims, spends the shared retry budget (exhaustion first,
// then weekly reconciliation), and persists the result. Framework-agnostic
// (no "use server", no cookies()) — called by src/app/plan/actions.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  allSlotIds,
  perMealTarget,
  weeklyTarget as computeWeeklyTarget,
  slotKey,
  MEALS_PER_WEEK,
  type MealSlotId,
  type MacroTargets,
} from "./targets";
import { resolveDiet, resolveIntolerances } from "./dietaryMapping";
import { classifyTier, type MacroBounds, type ToleranceTier } from "./tolerance";
import { rankCandidates, type PantryItem, type RecipeCandidate } from "./ranking";
import { runCascadeForSlot, matchLabelFor, type FetchCandidatesFn } from "./cascade";
import { createRetryBudget, trySpend, RECIPE_ACTION_COST, ADDON_ATTEMPT_COST } from "./retryBudget";
import { resolveClaims, type ClaimedSlot } from "./claim";
import {
  weeklyBand,
  sumActuals,
  macroGapDirections,
  dominantDirection,
  dominantIncreaseGap,
  pickSlackSlots,
  nudgedBounds,
} from "./reconciliation";
import { buildAddonForSlot, type SlotAddon } from "./addon";
import { recipeCacheKey, isStale } from "./cacheKey";
import {
  complexSearch,
  lookupIngredientMacros,
  SpoonacularQuotaError,
  SpoonacularRequestError,
} from "@/lib/spoonacular";
import { createAdminClient } from "@/lib/supabase/admin";

export { SpoonacularQuotaError, SpoonacularRequestError };

// Recomputed fresh from claimResult.claimed + the addons map every time,
// rather than incrementally tracked — sumActuals(claimResult.claimed) alone
// silently drops add-on macros whenever it's called again later (e.g. after
// phase 2's recipe swaps), which is exactly the kind of staleness bug this
// avoids by never trusting a previously-incremented running total.
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

// All 21 slots share the identical per-meal target in this MVP's model
// (daily macros divided equally across breakfast/lunch/dinner), so ONE
// query's candidate pool has to cover all 21 unique claims. cascade.ts now
// always fetches at the widest tier (p30) rather than only widening when
// the tightest tier is empty — verified live against Spoonacular: for an
// unrestricted 60g-protein/meal profile, p30 alone has 226 real matches
// (vs p10's 25), and only fetching the tightest tier left almost nothing
// for the carb/fat compliance preference to work with (1/25 vs 6/40
// compliant). 60 gives real headroom over that wider population without
// over-fetching — still just ONE deduped call per unique query per
// generation.
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
  const perMeal = perMealTarget(input.dailyTargets);
  const weekly = computeWeeklyTarget(input.dailyTargets);

  const diet = resolveDiet(input.dietaryStyles);
  const intolerances = resolveIntolerances(input.dietaryStyles);
  const excludeIngredients = [...input.allergies, ...input.dislikes];
  const budgetPerMealUsd = input.weeklyBudgetUsd !== null ? input.weeklyBudgetUsd / MEALS_PER_WEEK : null;
  const rankOpts = { tier: input.tier, budgetPerMealUsd, pantryItems: input.pantryItems };

  const admin = createAdminClient();
  // All 21 slots share the identical per-meal target, so at a given tier
  // they all compute the same cache key — without this, Promise.all below
  // would race 21 concurrent callers past a cold-cache miss and each would
  // fire its own real Spoonacular call for what should be a single shared
  // request. Scoped to this one generation call (not module-level) so it
  // can't leak across requests/users.
  const inFlight = new Map<string, Promise<RecipeCandidate[]>>();

  const makeFetcher = (excludeIds: number[]): FetchCandidatesFn => (bounds, tier) =>
    fetchCandidatesWithCache(admin, { bounds, tier, diet, intolerances, excludeIngredients }, excludeIds, inFlight);

  const slotIds = allSlotIds();
  const cascades = await Promise.all(
    slotIds.map(() => runCascadeForSlot(perMeal, makeFetcher([]), rankOpts)),
  );

  const claimResult = resolveClaims(slotIds.map((slotId, i) => ({ slotId, cascade: cascades[i] })));
  const blockedHints = new Map<string, string>();
  for (const slotId of claimResult.blockedSlots) {
    const cascade = cascades[slotIds.findIndex((s) => slotKey(s) === slotKey(slotId))];
    blockedHints.set(slotKey(slotId), cascade.blockingHint ?? "No recipe matched this meal's targets.");
  }

  const retryBudget = createRetryBudget();
  let retryQueriesUsed = 0;

  // Exhaustion re-queries first (rare) — one attempt each, excluding every
  // recipe already claimed elsewhere in this plan.
  for (const slotId of claimResult.exhaustedSlots) {
    if (!trySpend(retryBudget, RECIPE_ACTION_COST)) break;
    retryQueriesUsed++;
    const claimedIds = claimResult.claimed.map((c) => c.candidate.id);
    const cascade = await runCascadeForSlot(perMeal, makeFetcher(claimedIds), rankOpts);
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

  // Weekly reconciliation. Two phases sharing the same capped retry budget
  // (retryBudget.ts: points-weighted, not flat actions — a recipe requery
  // costs RECIPE_ACTION_COST, an add-on attempt costs the cheaper
  // ADDON_ATTEMPT_COST, reflecting their real Spoonacular cost difference):
  //
  // 1. Snack/add-on gap-closer (F3, tried first) — an add-on can only ever
  //    ADD macros, so it's only useful for "increase" gaps (weekly actual
  //    too low); a "decrease" gap (too high) skips straight to phase 2.
  //    Sized to the slot's own 20%-of-calories cap (addon.ts), so one
  //    attempt rarely closes a whole weekly gap by itself — the loop keeps
  //    attaching add-ons to different slack slots (never the same slot
  //    twice) until the gap closes or the budget runs out.
  // 2. Full recipe requery (existing, single targeted re-fetch per slack
  //    slot rather than a fresh 3-tier cascade) — for whatever's left
  //    after phase 1, on both remaining "increase" gaps and any "decrease"
  //    gaps. Slots already given an add-on this round are excluded here,
  //    so a slot never gets both an add-on and a full recipe swap in the
  //    same reconciliation pass (would leave a stale, no-longer-relevant
  //    add-on attached to a newly-swapped recipe).
  const addons = new Map<string, SlotAddon>();
  const addonedThisRound = new Set<string>();

  let gaps = macroGapDirections(sumWithAddons(claimResult.claimed, addons), weeklyBand(weekly));
  let increaseGap = dominantIncreaseGap(gaps);
  while (increaseGap && trySpend(retryBudget, ADDON_ATTEMPT_COST)) {
    retryQueriesUsed++;

    const eligible = claimResult.claimed.filter((c) => !addonedThisRound.has(slotKey(c.slotId)));
    const [targetSlotId] = pickSlackSlots(eligible, perMeal, [increaseGap], 1);
    if (!targetSlotId) break; // no slot left to try an add-on on this round

    const existing = claimResult.claimed.find((c) => slotKey(c.slotId) === slotKey(targetSlotId));
    if (!existing) break;

    const addon = await buildAddonForSlot(existing.candidate.caloriesKcal, increaseGap, lookupIngredientMacros);
    addonedThisRound.add(slotKey(targetSlotId));
    if (addon) {
      addons.set(slotKey(targetSlotId), addon);
    }
    // If no addon was returned (ingredient unresolved or too small to
    // matter), the slot is still marked addonedThisRound so the next
    // iteration tries a different slot rather than repeating the same
    // failure — never fakes progress that didn't happen.

    gaps = macroGapDirections(sumWithAddons(claimResult.claimed, addons), weeklyBand(weekly));
    increaseGap = dominantIncreaseGap(gaps);
  }

  if (gaps.length > 0) {
    const direction = dominantDirection(gaps)!;
    const eligible = claimResult.claimed.filter((c) => !addonedThisRound.has(slotKey(c.slotId)));
    const affordableRequeries = Math.floor(retryBudget.remaining / RECIPE_ACTION_COST);
    const slackSlotIds = pickSlackSlots(eligible, perMeal, gaps, affordableRequeries);

    for (const slotId of slackSlotIds) {
      if (!trySpend(retryBudget, RECIPE_ACTION_COST)) break;
      retryQueriesUsed++;

      const existingIndex = claimResult.claimed.findIndex((c) => slotKey(c.slotId) === slotKey(slotId));
      if (existingIndex === -1) continue;
      const existing = claimResult.claimed[existingIndex];

      const claimedIds = claimResult.claimed
        .filter((_, i) => i !== existingIndex)
        .map((c) => c.candidate.id);
      const bounds = nudgedBounds(perMeal, direction);
      const raw = await fetchCandidatesWithCache(
        admin,
        // Reconciliation's nudge doesn't correspond to a named p10/p20/p30
        // tier — reuse the slot's own original tier purely as a label for
        // the cache row's informational tolerance_tier column.
        { bounds, tier: existing.tier, diet, intolerances, excludeIngredients },
        claimedIds,
        inFlight,
      );
      const ranked = rankCandidates(raw, perMeal, rankOpts);
      const pick = ranked.find((c) => !claimedIds.includes(c.id));
      if (pick) {
        // The nudge intentionally searches outside the slot's original
        // tier — recompute the pick's real tier against the true per-meal
        // target (not the nudged one) so the persisted label/match_label
        // honestly reflects it, rather than carrying over a stale tier
        // that no longer matches the actual deviation.
        const actualTier = classifyTier(pick, perMeal) ?? "p30";
        claimResult.claimed[existingIndex] = { slotId, candidate: pick, tier: actualTier };
      }
      // If nothing found, leave the existing claim unchanged — the gap
      // simply isn't closed for that slot (never fakes an exact match).
    }
  }

  const actual = sumWithAddons(claimResult.claimed, addons);
  const stillOutside = macroGapDirections(actual, weeklyBand(weekly));
  const reconciliationStatus = stillOutside.length === 0 ? "within_band" : "outside_band_after_retries";

  const slots: OrchestratedSlot[] = claimResult.claimed.map((c) => ({
    slotId: c.slotId,
    candidate: c.candidate,
    tier: c.tier,
    matchLabel: matchLabelFor(c.tier, c.candidate, perMeal),
    addon: addons.get(slotKey(c.slotId)),
  }));

  const blockedSlots = [...blockedHints.entries()].map(([key, blockingHint]) => ({
    slotId: slotIds.find((s) => slotKey(s) === key)!,
    blockingHint,
  }));

  console.log(
    `[mealplan] generation done: ${slots.length}/21 claimed, ${blockedSlots.length} blocked, ` +
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
    });

    console.log(
      `[mealplan] fetched ${fresh.length} raw candidates from Spoonacular ` +
        `(bounds=${JSON.stringify(query.bounds)}, diet=${query.diet ?? "none"})`,
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
  const perMeal = perMealTarget(input.dailyTargets);
  const diet = resolveDiet(input.dietaryStyles);
  const intolerances = resolveIntolerances(input.dietaryStyles);
  const excludeIngredients = [...input.allergies, ...input.dislikes];
  const budgetPerMealUsd = input.weeklyBudgetUsd !== null ? input.weeklyBudgetUsd / MEALS_PER_WEEK : null;

  const admin = createAdminClient();
  const inFlight = new Map<string, Promise<RecipeCandidate[]>>();
  const fetcher: FetchCandidatesFn = (bounds, tier) =>
    fetchCandidatesWithCache(
      admin,
      { bounds, tier, diet, intolerances, excludeIngredients },
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
