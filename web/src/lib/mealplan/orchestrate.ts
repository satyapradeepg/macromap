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
  markKnownBad,
  knownBadIdsFor,
  type MealSlotId,
  type MacroTargets,
  type MealType,
} from "./targets";
import { resolveDiet, resolveIntolerances, unsupportedDietaryStyles } from "./dietaryMapping";
import { classifyTier, TOLERANCE_PCT, type MacroBounds, type ToleranceTier } from "./tolerance";
import { rankCandidates, macroDeviationScore, type PantryItem, type RecipeCandidate, type RankedCandidate } from "./ranking";
import {
  buildPantryRemainingTracker,
  commitPantryConsumption,
  releasePantryConsumption,
  resolvePantryMatchInfo,
  type PantryRemainingTracker,
} from "./pantryRemaining";
import { runCascadeForSlot, matchLabelFor, type FetchCandidatesFn } from "./cascade";
import { auditDepletionBlindSpot } from "./depletionAudit";
import {
  createRetryBudget,
  trySpend,
  RECIPE_ACTION_COST,
  ADDON_ATTEMPT_COST,
  createAiComposeBudget,
  createBadFitSwapBudget,
  AI_COMPOSE_ACTION_COST,
  MAX_AI_COMPOSE_ATTEMPTS_PER_SLOT,
  createPlanRepairBudget,
  createSelectionAddonBudget,
  type RetryBudget,
} from "./retryBudget";
import { resolveClaims, type ClaimedSlot } from "./claim";
import {
  toleranceBand,
  sumActuals,
  macroGapDirections,
  isWithinBand,
  dominantIncreaseGap,
  pickSlackSlots,
  nudgedBounds,
  amountNeededFor,
  type MacroGapDirection,
} from "./reconciliation";
import { buildAddonForSlot, type SlotAddon, type IngredientMacroLookup, type FetchIngredientMacrosFn } from "./addon";
import { composeSnack, composedSnackTitle, allPoolIngredientNames } from "./snackComposition";
import { lookupIngredientMacrosStatic } from "./staticIngredientMacros";
import { filterSafeIngredientNames, type DietaryContext } from "./ingredientSafety";
import { type PantryPriceContext } from "./pantryPricePreference";
import {
  composeMealFromProposalDetailed,
  composeMealFromProposalBestEffort,
  describeRejectionForFeedback,
  bestKnownDensity,
  PORTION_BOUNDS_G,
  type GroundedIngredientData,
  type CompositionRejection,
  type MealProposal,
} from "./aiMealComposition";
import { proposeMealViaClaude, proposeMealsBatchViaClaude } from "./mealProposer";
import { anyIngredientUnsafeFor, isRecipeTitleUnsafeFor } from "./openEndedIngredientSafety";
import { critiquePlan, type PlanSlotSummary } from "./planCritic";
import { shouldAcceptRepair } from "./planRepair";
import { recipeCacheKey, isStale } from "./cacheKey";
import { lookupIngredientMacrosCached } from "./ingredientMacroCache";
import {
  complexSearch,
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
  pool: Record<
    string,
    { id: number; name: string; caloriesPer100g: number; proteinGPer100g: number; carbsGPer100g: number; fatGPer100g: number; estimatedCostCentsPer100g: number | null }
  >,
  varietySeed: number,
  id: number,
  pantryPriceCtx: PantryPriceContext,
  budgetPerMealUsd: number | null,
): RankedCandidate | null {
  const composed = composeSnack(target, pool, varietySeed, pantryPriceCtx);
  if (composed.ingredients.length === 0) return null;

  // Real cost now available (staticIngredientMacros.ts, retrofitted July
  // 15 2026) — same budgetCompliant definition as ranking.ts's recipe
  // path: only ever checked when Pro + a budget is actually set, and a
  // null price (partial cost data) is never treated as non-compliant.
  // Rounded to an integer -- meal_plan_slots.price_per_serving_cents is an
  // integer column; Spoonacular's own pricePerServing hit this exact same
  // "invalid input syntax for type integer" failure earlier in this
  // project (a float slipped through unrounded) and the fix there was the
  // same: round at the point a real value becomes this column's input.
  const pricePerServingCents = composed.totalEstimatedCostCents !== null ? Math.round(composed.totalEstimatedCostCents) : null;
  const budgetCompliant =
    !pantryPriceCtx.budgetAware || pricePerServingCents === null || budgetPerMealUsd === null || pricePerServingCents <= budgetPerMealUsd * 100;

  return {
    id,
    title: composedSnackTitle(composed),
    imageUrl: null,
    servings: 1,
    proteinG: composed.totalProteinG,
    caloriesKcal: composed.totalCalories,
    carbsG: composed.totalCarbsG,
    fatG: composed.totalFatG,
    pricePerServingCents,
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
    budgetCompliant,
    // "p10" here means "composed directly to target," not a recipe-search
    // tolerance tier — matchLabelFor treats it the same as a clean match,
    // which is correct: composition doesn't have a "closest available"
    // tradeoff the way recipe search does.
    actualTier: "p10",
    isFallbackOfLastResort: false,
    // Composed directly to target, not scaled from a fixed-size recipe.
    scaleFactor: 1,
  };
}

// The 9 pool ingredients are a fixed, non-user-specific set (see
// staticIngredientMacros.ts) — reads from the pinned table instead of
// querying Spoonacular live on every generation/swap. Falls back to a real
// live lookup for any name the static table doesn't recognize (e.g. if
// INGREDIENT_POOL ever grows without the static table being refreshed) so
// results stay grounded in real data either way, never fabricated.
//
// ctx filters OUT any name unsafe for this profile (ingredientSafety.ts)
// BEFORE it's ever added to the returned pool — found and fixed July 15
// 2026 after confirming this function previously built the pool from ALL
// 9 names unconditionally, so e.g. a nut allergy could get served almonds
// in a composed snack. snackComposition.ts's pickFromPool then rotates
// among whatever's actually present in the (pre-filtered) pool.
async function fetchSnackIngredientPool(ctx: DietaryContext) {
  const safeNames = filterSafeIngredientNames(allPoolIngredientNames(), ctx);
  const poolEntries = await Promise.all(
    safeNames.map(async (name) => {
      const staticMatch = lookupIngredientMacrosStatic(name);
      if (staticMatch) return [name, staticMatch] as const;
      return [name, await lookupIngredientMacrosCached(name)] as const;
    }),
  );
  return Object.fromEntries(
    poolEntries.filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null),
  );
}

// Same static-first, live-fallback pattern for addon.ts's fixed
// per-macro ingredient options (the same 9-ingredient pool) — used
// wherever an add-on lookup previously called lookupIngredientMacros
// directly. Safety filtering (allergy/diet/dislike) happens inside
// addon.ts's buildAddonForSlot itself (it tries each of its per-macro
// candidates in order and skips unsafe ones) — this wrapper only resolves
// real macro data for whichever candidate addon.ts decided to try.
const lookupIngredientMacrosForAddon: FetchIngredientMacrosFn = async (query: string): Promise<IngredientMacroLookup | null> => {
  const staticMatch = lookupIngredientMacrosStatic(query);
  if (staticMatch) return staticMatch;
  return lookupIngredientMacrosCached(query);
};

// aiMealComposition.ts's ingredients are open-ended (Claude's own choice,
// not from the fixed 9), so this always resolves live — no static-table
// shortcut applies here the way it does for the fixed pool above.
async function groundIngredientForAiMeal(query: string): Promise<GroundedIngredientData | null> {
  return lookupIngredientMacrosCached(query);
}

// `addons` is one Map shared across the WHOLE week (declared once, not
// per-day) -- iterating addons.values() unconditionally, as this used to,
// summed every addon in the entire plan into whatever `claimed` subset was
// passed in, not just the addons belonging to it. Every day-scoped caller
// (all of reconciliation's gap checks, both never-worse guards, and the
// final per-day within_band/outside_band_after_retries status) was getting
// silently inflated by every OTHER day's addons too -- worse for later
// days, since addons added during earlier days' own reconciliation stay in
// the same shared map. Found live 2026-07-27 while implementing the
// phase-2 recompute+guard fix above. Fixed by looking up each of THIS
// call's own `claimed` slots' addon via slotKey (which already encodes
// day+mealType) instead of blindly draining the whole map -- behavior-
// preserving for the one caller that already passes the full week's
// claimed list (summing via lookup over that same list is identical to
// summing every map value, since every addon always belongs to some
// claimed slot), and behavior-correcting for every day-scoped caller.
function sumWithAddons(claimed: ClaimedSlot[], addons: Map<string, SlotAddon>): MacroTargets {
  let total = sumActuals(claimed);
  for (const c of claimed) {
    const addon = addons.get(slotKey(c.slotId));
    if (!addon) continue;
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
// (1/25 vs 6/40 compliant). Kept the same for both meal-type pools for now
// rather than tuning breakfast's smaller 7-claim need separately — no live
// fill-rate data yet to justify a different number per type.
//
// Raised 60 -> 100 (Spoonacular's real per-call max, live-confirmed: a
// number=100 call returns exactly 100 results, no error) as the queue's
// budget-vs-grocery-price gap investigation's one safe, low-risk lever:
// ranking.ts's budget-compliant candidates are placed entirely ahead of
// non-compliant ones whenever at least one exists (ranking.ts:310-315,
// deliberate/tested, NOT a weak tiebreak) -- but at realistic per-meal
// budgets that compliant subset is usually EMPTY (live-confirmed: even a
// loose $60/week budget had only 1/60 compliant candidates), which is why
// budget behaves like a no-op in practice. More candidates per fetch is
// the lever that actually helps -- it raises how often that already-strong
// preference gets to fire at all. ranking.ts's own scoring/partition logic
// is untouched by this change.
//
// This changes recipe_query_cache's cache key (resultCount is part of the
// hashed signature, cacheKey.ts) -- a one-time, bounded cold-cache event
// across the whole cache table right after deploy (old rows simply stop
// matching, no migration/backfill needed), not an ongoing cost; the cache
// is cross-user with a 7-day TTL, so the extra real Spoonacular cost per
// distinct (bounds, diet, type, ...) combo is paid once per 7-day window,
// amortized across every user hitting that combo.
const CANDIDATES_PER_QUERY = 100;

// Caps how many slots go into a single proposeMealsBatchViaClaude call
// (2026-07-28, alongside createBadFitSwapBudget becoming adaptive) --
// widening that budget means `eligible` can now genuinely hold many more
// entries for a diet-restricted profile. mealProposer.ts's batch prompt
// computes ONE shared "concentrate protein into fewer dishes" strategy
// across the whole batch (its own maxSlotProteinG is batch-wide, not
// per-chunk) -- dumping too many heterogeneous slots into one call dilutes
// that guidance per-dish. Chunking keeps each call's guidance focused
// without capping how many total slots can get repaired in a generation.
const MAX_AI_COMPOSE_BATCH_SIZE = 4;

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
  // A flagged diet_violation the repair pass couldn't resolve even after
  // both the real-recipe swap attempt and the AI-composition fallback —
  // see the "Post-generation plan critique + repair" section below.
  // Expected empty in the overwhelming majority of plans. No frontend
  // consumer yet (see plan-critic-diet-violation-spec-2026-07-16.md,
  // OQ-B) — this is the data shape for a follow-up warning banner.
  unresolvedDietaryConcerns: Array<{ dayIndex: number; mealType: string; note: string }>;
  // planCritic.ts's 1-2 sentence take on the week's variety/macro fit,
  // computed during generation (before any critic-triggered repair swaps
  // run) -- null if the critique itself was skipped or failed (no
  // ANTHROPIC_API_KEY, or a recoverable API error).
  weeklyAssessment: string | null;
}

export async function orchestrateGeneration(input: OrchestrateInput): Promise<OrchestrateResult> {
  const mealTypeTargets = allMealTypeTargets(input.dailyTargets);
  const weekly = computeWeeklyTarget(input.dailyTargets);

  const diet = resolveDiet(input.dietaryStyles);
  const intolerances = resolveIntolerances(input.dietaryStyles);
  const excludeIngredients = [...input.allergies, ...input.dislikes];
  const budgetPerMealUsd = input.weeklyBudgetUsd !== null ? input.weeklyBudgetUsd / MEALS_PER_WEEK : null;
  // Quantity-aware pantry depletion (pantryRemaining.ts) starts as an
  // UNRESOLVED tracker (no identity-match/unit-conversion data yet) --
  // matchesPantryItem's namesOverlap fallback makes this behave exactly
  // like today's boolean-only check for the initial 21-slot fan-out
  // below, which necessarily ranks every slot from the same snapshot
  // before any of them are claimed (see the real resolution swap-in right
  // after cascadeSettled, and this feature's own plan doc for why the
  // initial pass can only be "bookkeeping-correct," not genuinely
  // depletion-aware in its own scoring). `rankOpts` is a single mutable
  // object threaded by reference into every rankCandidates/
  // runCascadeForSlot call in this function (including retries below) --
  // replacing `rankOpts.pantryTracker` once real data is ready makes
  // every call site after that point see it for free.
  const rankOpts = {
    tier: input.tier,
    budgetPerMealUsd,
    pantryTracker: buildPantryRemainingTracker(input.pantryItems, new Map()),
  };
  const dietaryCtx: DietaryContext = {
    dietaryStyles: input.dietaryStyles,
    allergies: input.allergies,
    dislikes: input.dislikes,
  };
  // Pantry/price preference (retrofitted July 15 2026) for the composed
  // snack/add-on system — same budget-aware definition ranking.ts already
  // uses for recipes (Pro tier + a budget actually set), so composed items
  // participate in the same "budget preference is a Pro perk" model.
  const pantryItemNames = input.pantryItems.map((p) => p.name);
  const pantryPriceCtx: PantryPriceContext = {
    pantryItemNames,
    budgetAware: input.tier === "pro" && budgetPerMealUsd !== null,
  };

  const admin = createAdminClient();
  // All slots of the SAME meal type share an identical target, so at a
  // given tier they all compute the same cache key — without this,
  // Promise.all below would race N concurrent callers past a cold-cache
  // miss and each would fire its own real Spoonacular call for what should
  // be one shared request per meal type. Scoped to this one generation
  // call (not module-level) so it can't leak across requests/users.
  const inFlight = new Map<string, Promise<RecipeCandidate[]>>();

  const makeFetcher = (excludeIds: number[], type: string): FetchCandidatesFn => (bounds, tier) =>
    fetchCandidatesWithCache(
      admin,
      { bounds, tier, diet, intolerances, excludeIngredients, type, dietaryStyles: input.dietaryStyles, allergies: input.allergies },
      excludeIds,
      inFlight,
    );

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

  // Now that real candidate data exists, resolve genuine identity-match/
  // unit-conversion info for every pantry item against it and swap the
  // UNRESOLVED tracker built above for a real one -- every rankCandidates
  // call from this point on (exhaustion retries just below, and every
  // later reconciliation/protein-floor/repair requery) reads
  // `rankOpts.pantryTracker` fresh, so replacing the object here is
  // enough to make all of them depletion-aware for free. Reuses the
  // candidate pool already fetched above instead of a separate fetch --
  // no additional Spoonacular cost. Any failure here (network/LLM outage)
  // degrades to the same unresolved tracker already in place -- never
  // blocks generation, same "never let an external outage kill
  // generation" rule as the snack-pool fetch below.
  if (input.pantryItems.length > 0) {
    const candidateIngredientUniverse = cascades.flatMap((c) =>
      c.rankedCandidates.flatMap((rc) => rc.ingredients.map((ing) => ({ name: ing.name, unit: ing.metricUnit }))),
    );
    try {
      const matchInfo = await resolvePantryMatchInfo(input.pantryItems, candidateIngredientUniverse);
      rankOpts.pantryTracker = buildPantryRemainingTracker(input.pantryItems, matchInfo);
    } catch {
      // Leave the unresolved tracker in place -- boolean-only fallback.
    }
  }

  const claimResult = resolveClaims(recipeSlotIds.map((slotId, i) => ({ slotId, cascade: cascades[i] })));

  // Diagnostic-only detection pass (depletionAudit.ts) for the same-pass
  // pantry-depletion blind spot documented above and in
  // pantryRemaining.ts's Phase 1 header -- never affects this or any real
  // plan (operates on a cloned tracker, wrapped so a bug here can't reach
  // the real generation). Logs only when at least one slot would have
  // scored differently with live depletion visibility, so this accumulates
  // real evidence across real generations before any restructure is
  // considered, instead of guessing again.
  try {
    const claimedBySlotKey = new Map(claimResult.claimed.map((c) => [slotKey(c.slotId), c.candidate]));
    const divergences = auditDepletionBlindSpot(
      recipeSlotIds,
      cascades,
      mealTypeTargets,
      claimedBySlotKey,
      rankOpts.pantryTracker,
      { tier: rankOpts.tier, budgetPerMealUsd: rankOpts.budgetPerMealUsd },
    );
    if (divergences.length > 0) {
      console.log(
        `[mealplan] depletion-blind-spot audit: ${divergences.length}/${claimResult.claimed.length} slot(s) would score differently with live depletion visibility: ` +
          divergences
            .map(
              (d) =>
                `${d.slotKey} actual=${d.actualCandidateId}(score ${d.actualScore.toFixed(3)}) simulated=${d.simulatedCandidateId}(score ${d.simulatedScore.toFixed(3)})`,
            )
            .join("; "),
      );
    }
  } catch (err) {
    console.log("[mealplan] depletion-blind-spot audit failed (diagnostic only, ignored):", err);
  }

  // Bookkeeping for the initial pass -- every one of these 21 (or fewer)
  // slots was already scored/picked before any of them were committed
  // (the initial fan-out above ranks all slots from one shared snapshot),
  // so this can't change which candidate won a slot in THIS pass. It's
  // still required: every later touch (exhaustion retry just below, day
  // reconciliation, protein-floor, repair) reads `rankOpts.pantryTracker`
  // live, and needs it to correctly reflect what these initial picks
  // already used.
  for (const claimed of claimResult.claimed) {
    commitPantryConsumption(rankOpts.pantryTracker, claimed.candidate.ingredients);
  }
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

  // Retry-with-feedback instrumentation (2026-07-30) -- surfaced in the
  // end-of-generation summary log below, same attachment point as
  // retryQueriesUsed. Exists to answer, from real live runs rather than
  // assumption: what actually rejects composeMealFromProposal (the
  // rejection-kind breakdown), and does the bounded retry actually recover
  // any of them (attempts vs. successes).
  const aiComposeRejectionCounts: Partial<Record<CompositionRejection["kind"], number>> = {};
  function recordAiComposeRejection(reason: CompositionRejection): void {
    aiComposeRejectionCounts[reason.kind] = (aiComposeRejectionCounts[reason.kind] ?? 0) + 1;
  }
  let aiComposeRetryAttempts = 0;
  let aiComposeRetrySuccesses = 0;

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
      // Genuinely depletion-aware -- this pick was scored against
      // rankOpts.pantryTracker AFTER the initial 21 slots' commits above,
      // so it already reflects what they used.
      commitPantryConsumption(rankOpts.pantryTracker, pick.ingredients);
    } else {
      blockedHints.set(
        slotKey(slotId),
        cascade.blockingHint ?? "Every close match for this meal is already used elsewhere this week.",
      );
    }
  }

  // Any exhausted slot the loop above never got to (the budget ran out
  // via the `break` above, or a quota error broke early) used to vanish
  // completely -- neither claimed nor blocked, not present in the final
  // plan at all, with zero explanation. Live-confirmed July 16 2026
  // (comprehensive engine test): a real restrictive profile produced a
  // plan missing 3 of 35 meals this way. Every entry in exhaustedSlots
  // must end up in exactly one of claimed/blockedHints by this point.
  for (const slotId of claimResult.exhaustedSlots) {
    const key = slotKey(slotId);
    const alreadyClaimed = claimResult.claimed.some((c) => slotKey(c.slotId) === key);
    if (!alreadyClaimed && !blockedHints.has(key)) {
      blockedHints.set(key, "Every close match for this meal is already used elsewhere this week.");
    }
  }

  // Snack slots (snack1/snack2): composed from a small ingredient pool
  // fetched ONCE here and reused for all 14 snack slots this week — a
  // fresh 2-3 lookup per slot would cost ~84 Spoonacular points/plan (3
  // lookups x 2pts x 14 slots); fetching the fixed 9-ingredient pool once
  // costs ~18 points regardless of how many snack slots use it. This is a
  // real, permanent addition to baseline per-plan cost (every plan now has
  // 14 snack slots), not a rare reconciliation-only cost.
  // Wrapped in the same recoverable-error catch every other Spoonacular
  // call site in this file already uses -- found unguarded July 16 2026
  // (comprehensive engine test): this fetches for EVERY safe pool
  // ingredient not in the static table, so a quota error here used to
  // throw uncaught, propagate out of orchestrateGeneration, and get
  // treated as total generation failure by actions.ts's top-level catch
  // -- discarding every recipe slot already claimed above. Degrades to
  // an empty pool instead: every snack slot below already handles a null
  // composedSnackCandidate result by blocking that slot with a clear
  // hint, so an empty pool just means "snacks blocked this generation,"
  // never a lost plan.
  let snackIngredientPool: Awaited<ReturnType<typeof fetchSnackIngredientPool>>;
  try {
    snackIngredientPool = await fetchSnackIngredientPool(dietaryCtx);
  } catch (err) {
    if (!isRecoverableSpoonacularError(err)) throw err;
    console.error("[mealplan] snack ingredient pool fetch failed (quota/outage), snacks blocked this generation:", err);
    snackIngredientPool = {};
  }

  let syntheticSnackId = -1;
  // Distinct negative range from syntheticSnackId, purely so a synthetic
  // id is human-recognizable in logs/DB rows as "AI-composed meal" vs
  // "composed snack" at a glance — the aiComposed flag on RankedCandidate
  // is what code actually keys off, not this range.
  let syntheticAiMealId = -100000;
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
      pantryPriceCtx,
      budgetPerMealUsd,
    );

    if (!candidate) {
      blockedHints.set(slotKey(slotId), "Couldn't compose a snack close to this meal's targets.");
      continue;
    }
    claimResult.claimed.push({ slotId, candidate, tier: "p10" });
  }

  // Addon-at-selection (Phase 2, July 20 2026 spec). Portion scaling
  // (ranking.ts's bestScaleAndScore) can only perfectly fit ONE macro's
  // ratio per candidate — confirmed live to leave a real residual gap on
  // the others (e.g. a baseline profile's fat deviation got WORSE even as
  // calories/protein improved). This gives every freshly-claimed recipe
  // slot one shot at closing whatever gap scaling couldn't reach, using the
  // already-proven `buildAddonForSlot` mechanism (previously only invoked
  // reactively during the day-by-day reconciliation loop below). Composed
  // snacks/AI-composed meals are skipped — they're already sized directly
  // to target (scaleFactor 1), nothing for an addon to top up.
  //
  // `addons` is declared here (not below, where it used to live) so this
  // pass and the reconciliation loop below share one Map — an addon
  // attached here is indistinguishable to everything downstream (sumWithAddons,
  // the final OrchestratedSlot assembly) from one attached during
  // reconciliation.
  const addons = new Map<string, SlotAddon>();
  const selectionAddonBudget = createSelectionAddonBudget();

  // Generation-scoped "known-bad" recipe tracking (2026-07-28) -- shared by
  // every pass below that can replace a real recipe candidate (day
  // reconciliation's Phase 2 requery, the protein-floor swap, the bad-fit
  // AI-compose pass, and plan-repair). Live-confirmed bug this closes: a
  // recipe correctly removed by one pass for being a bad fit had nothing
  // stopping a LATER, independent pass from pulling it back in for a
  // different slot from the same cached pool, since only "currently
  // claimed elsewhere" was ever excluded -- never "already rejected this
  // generation." See targets.ts's markKnownBad/knownBadIdsFor for why this
  // is keyed by (id, Spoonacular type class) rather than bare id.
  const excludedRecipeKeys = new Set<string>();

  // Only called from the initial pass below. Tried also calling this again
  // after every later reconciliation swap (to give a freshly-swapped pick a
  // fair shot at whatever gap it has) — live-confirmed July 20 2026 that
  // this over-added macros in combination with reconciliation's own
  // corrective swaps, making every profile's accuracy worse, not better.
  // Reconciliation's swap sites now just clear a stale addon and leave the
  // slot addon-free instead of re-rolling one; see phase 2's swap-eligibility
  // soft preference below for how addon'd slots stay protected from being
  // disturbed in the first place, absent that.
  async function tryAttachAddon(claimed: ClaimedSlot): Promise<void> {
    if (slotMechanism(claimed.slotId.mealType) !== "recipe") return;
    const target = mealTypeTargets[claimed.slotId.mealType];
    const candidateAsTargets: MacroTargets = {
      calories: claimed.candidate.caloriesKcal,
      proteinG: claimed.candidate.proteinG,
      carbsG: claimed.candidate.carbsG,
      fatG: claimed.candidate.fatG,
    };
    // p10 (10%), not the aggregate reconciliation band's tighter 5% -- a
    // single freshly-scaled recipe is noisier than a multi-slot aggregate,
    // so this reuses the already-tuned per-candidate "closest match"
    // tolerance from tolerance.ts instead of a new magic number.
    //
    // Tried p20 (20%) live July 20 2026, hoping stricter coverage would
    // leave more non-addon'd slot inventory per day for the swap-eligibility
    // soft preference below to work with -- it overshot the other way
    // (addon-at-selection stopped firing at all in that run, carbs got
    // worse than Phase 1 alone). Reverted to p10.
    //
    // Partially resolved 2026-07-27: Phase 2's recipe-requery bounds
    // (nudgedBounds, reconciliation.ts) used to apply ONE shared direction
    // to all 4 macros, so a carb-fixing swap could actively search for
    // MORE fat even while fat was already over target -- undoing this
    // phase's own fat-fixing addon as a side effect. Fixed: nudgedBounds
    // now nudges each macro in its own gap's direction (or a neutral band
    // if that macro's already in band), never an unrelated one. Still
    // real, still unresolved: dominantIncreaseGap (just below) picks WHICH
    // macro gets an addon attempt by raw overshoot, unweighted by
    // macroDeviationScore's own protein/calories-first weighting -- that's
    // a different question (target selection, not bounds direction) and
    // wasn't part of this fix.
    const gap = dominantIncreaseGap(macroGapDirections(candidateAsTargets, toleranceBand(target, TOLERANCE_PCT.p10)));
    if (!gap || !trySpend(selectionAddonBudget, ADDON_ATTEMPT_COST)) return;
    retryQueriesUsed++;
    // Aimed at the slot's true per-meal-type target, not just the p10 band
    // edge used above to decide whether a gap is worth bothering with at
    // all -- sizing to the band edge would leave a permanent residual on
    // this macro (macroDeviationScore has no band-awareness, see
    // reconciliation.ts), just burning more retry budget later to finish
    // the job this addon could have closed now.
    const neededAmount = amountNeededFor(candidateAsTargets[gap.macro], target[gap.macro]);
    const addon = await buildAddonForSlot(
      claimed.candidate.caloriesKcal,
      gap,
      lookupIngredientMacrosForAddon,
      dietaryCtx,
      pantryPriceCtx,
      neededAmount,
    );
    if (!addon) return;
    // Never-worse guard (found live + confirmed offline July 20 2026, via a
    // free cached-pool simulation): closing ONE macro's gap is not the same
    // as improving the slot's overall accuracy -- a real ingredient always
    // carries incidental calories/carbs/fat alongside whatever it targets,
    // and in the offline check only 4/26 candidate addons across 3 profiles
    // actually improved the slot's own macroDeviationScore once all 4
    // macros were accounted for. Mirrors bestScaleAndScore's own discipline
    // (ranking.ts) of never accepting a change unless it's demonstrably
    // better than doing nothing.
    const withAddon = {
      proteinG: claimed.candidate.proteinG + addon.proteinG,
      caloriesKcal: claimed.candidate.caloriesKcal + addon.caloriesKcal,
      carbsG: claimed.candidate.carbsG + addon.carbsG,
      fatG: claimed.candidate.fatG + addon.fatG,
    };
    if (macroDeviationScore(withAddon, target) >= macroDeviationScore(claimed.candidate, target)) return;
    addons.set(slotKey(claimed.slotId), addon);
  }

  try {
    for (const claimed of claimResult.claimed) {
      await tryAttachAddon(claimed);
    }
  } catch (err) {
    if (!isRecoverableSpoonacularError(err)) throw err;
    // Same "keep whatever's already built, never discard claims" rule as
    // every other Spoonacular-touching phase in this file — a quota/outage
    // error here just means fewer selection-time addons, not plan failure.
    console.error("[mealplan] addon-at-selection failed (quota/outage), continuing without further selection-time addons:", err);
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
  const dailyStatuses: Array<"within_band" | "outside_band_after_retries"> = [];

  for (let dayIndex = 0; dayIndex < DAYS_PER_WEEK; dayIndex++) {
    const daySlots = () => claimResult.claimed.filter((c) => c.slotId.dayIndex === dayIndex);
    // Seeded from any addon already attached during addon-at-selection above
    // (or, in principle, a slot re-visited within this same loop) — PRD F3
    // caps one add-on per slot for realism, so reconciliation must never
    // attempt a second one on a slot that already has one.
    const addonedThisDay = new Set(
      daySlots()
        .filter((c) => addons.has(slotKey(c.slotId)))
        .map((c) => slotKey(c.slotId)),
    );
    // Fresh per-day budget (see the comment above the loop) — not shared
    // with any other day, only with this day's own protein-floor
    // enforcement pass further down.
    const dayRetryBudget = createRetryBudget();
    // Shared by both gap-closing phases below -- macroDeviationScore's
    // candidate side uses caloriesKcal (asymmetric naming vs MacroTargets'
    // calories, already established elsewhere in this file/ranking.ts).
    const asCandidate = (a: MacroTargets) => ({ proteinG: a.proteinG, caloriesKcal: a.calories, carbsG: a.carbsG, fatG: a.fatG });

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

        const dayActualBefore = sumWithAddons(daySlots(), addons);
        // Aimed at the true daily target, not just the ±5% band edge that
        // triggered this loop -- same reasoning as Phase 0's addon-at-
        // selection above (macroDeviationScore has no band-awareness).
        const neededAmount = amountNeededFor(dayActualBefore[increaseGap.macro], input.dailyTargets[increaseGap.macro]);
        const addon = await buildAddonForSlot(existing.candidate.caloriesKcal, increaseGap, lookupIngredientMacrosForAddon, dietaryCtx, pantryPriceCtx, neededAmount);
        addonedThisDay.add(slotKey(targetSlotId));
        // Never-worse guard (found live + confirmed offline July 20 2026):
        // this pre-existing phase only ever checked "does this ingredient
        // close the ONE gap it targeted" -- never whether adding it (with
        // its own incidental calories/carbs/fat) actually leaves the DAY
        // closer to its target overall. A free offline simulation against
        // real cached pools found this pre-existing mechanism failed that
        // check 0/21 times across 3 profiles -- it had been silently
        // making the day's weighted accuracy worse every time it fired,
        // this whole time, independent of anything built this session.
        if (addon) {
          const dayActualWith = {
            calories: dayActualBefore.calories + addon.caloriesKcal,
            proteinG: dayActualBefore.proteinG + addon.proteinG,
            carbsG: dayActualBefore.carbsG + addon.carbsG,
            fatG: dayActualBefore.fatG + addon.fatG,
          };
          if (macroDeviationScore(asCandidate(dayActualWith), input.dailyTargets) < macroDeviationScore(asCandidate(dayActualBefore), input.dailyTargets)) {
            addons.set(slotKey(targetSlotId), addon);
          }
          // Guard-rejected addons are discarded, not kept -- but the slot
          // stays marked addonedThisDay (same as an unresolved lookup
          // below) so the next iteration tries a different slot rather
          // than re-attempting the same non-improving one.
        }
        // If no addon was returned (ingredient unresolved or too small to
        // matter), the slot is still marked addonedThisDay so the next
        // iteration tries a different slot rather than repeating the same
        // failure — never fakes progress that didn't happen.

        gaps = macroGapDirections(sumWithAddons(daySlots(), addons), dailyBand);
        increaseGap = dominantIncreaseGap(gaps);
      }

      // Recipe requery, one slot at a time, gap recomputed after every
      // attempt -- rebuilt 2026-07-27 to match phase 1's own discipline
      // above, after live instrumentation confirmed this phase used to
      // compute its whole batch of target slots ONCE from the gap snapshot
      // taken before this loop started, then execute all of them against
      // that same stale snapshot: swap #2/#3 had no idea what swap #1
      // already fixed. Also newly guarded the same way phase 1 already is
      // (macroDeviationScore before/after, see asCandidate above) -- this
      // phase previously had no check at all that a swap actually improved
      // the day's real fit, unlike phase 1's addon guard.
      const swapTriedThisDay = new Set<string>();
      while (gaps.length > 0 && trySpend(dayRetryBudget, RECIPE_ACTION_COST)) {
        retryQueriesUsed++;

        // Recipe requery only applies to recipe-mechanism slots — a composed
        // snack has no Spoonacular recipe to "requery" (mealTypeToSpoonacularType
        // throws for snack types); a snack with remaining slack only gets
        // helped by phase 1's add-on, not this phase.
        //
        // Prefer a slot that DOESN'T already carry a selection-time addon,
        // only reaching into addon'd ones once the non-addon'd pool is
        // exhausted. Found live July 20 2026: excluding addon'd slots
        // entirely (the original design) starved this phase once
        // addon-at-selection started touching roughly half the week's
        // recipe slots; swapping them completely unrestricted let this
        // phase cannibalize addon-at-selection's own fixing work. This soft
        // preference gets both. Both pools also exclude anything already
        // tried THIS phase today, whether the swap was accepted or
        // rejected — without that, a rejected slot (same cached candidates,
        // same guard outcome) would get re-picked and re-rejected
        // identically, burning the day's whole budget on one futile slot.
        const recipeSlotsToday = daySlots().filter((c) => slotMechanism(c.slotId.mealType) === "recipe");
        const nonAddonedEligible = recipeSlotsToday.filter(
          (c) => !addonedThisDay.has(slotKey(c.slotId)) && !swapTriedThisDay.has(slotKey(c.slotId)),
        );
        const addonedEligible = recipeSlotsToday.filter(
          (c) => addonedThisDay.has(slotKey(c.slotId)) && !swapTriedThisDay.has(slotKey(c.slotId)),
        );
        const pool = nonAddonedEligible.length > 0 ? nonAddonedEligible : addonedEligible;
        const [slotId] = pickSlackSlots(pool, mealTypeTargets, gaps, 1);
        if (!slotId) break; // no untried recipe slot left this day

        swapTriedThisDay.add(slotKey(slotId));

        const existingIndex = claimResult.claimed.findIndex((c) => slotKey(c.slotId) === slotKey(slotId));
        if (existingIndex === -1) continue;
        const existing = claimResult.claimed[existingIndex];

        const claimedIds = claimResult.claimed
          .filter((_, i) => i !== existingIndex)
          .map((c) => c.candidate.id)
          .concat(knownBadIdsFor(slotId.mealType, excludedRecipeKeys));
        const slotTarget = mealTypeTargets[slotId.mealType];
        const bounds = nudgedBounds(slotTarget, gaps);
        const raw = await fetchCandidatesWithCache(
          admin,
          // Reconciliation's nudge doesn't correspond to a named p10/p20/p30
          // tier — reuse the slot's own original tier purely as a label for
          // the cache row's informational tolerance_tier column.
          { bounds, tier: existing.tier, diet, intolerances, excludeIngredients, type: mealTypeToSpoonacularType(slotId.mealType), dietaryStyles: input.dietaryStyles, allergies: input.allergies },
          claimedIds,
          inFlight,
        );
        const ranked = rankCandidates(raw, slotTarget, rankOpts);
        const pick = ranked.find((c) => !claimedIds.includes(c.id));

        if (pick) {
          // Never-worse guard (new 2026-07-27, same shape as phase 1's addon
          // guard above): build the day's hypothetical actual with this
          // slot swapped in (and its old addon, if any, dropped -- a swap
          // always drops the old addon below, so the guard must account for
          // that too, not just the candidate's own macros) and only commit
          // if it's a genuine improvement against the real daily target.
          const dayActualBefore = sumWithAddons(daySlots(), addons);
          const hypotheticalClaimed = daySlots().map((c) =>
            slotKey(c.slotId) === slotKey(slotId) ? { ...c, candidate: pick } : c,
          );
          const hypotheticalAddons = new Map(addons);
          hypotheticalAddons.delete(slotKey(slotId));
          const dayActualWith = sumWithAddons(hypotheticalClaimed, hypotheticalAddons);

          if (macroDeviationScore(asCandidate(dayActualWith), input.dailyTargets) < macroDeviationScore(asCandidate(dayActualBefore), input.dailyTargets)) {
            // The nudge intentionally searches outside the slot's original
            // tier — recompute the pick's real tier against the true per-meal
            // target (not the nudged one) so the persisted label/match_label
            // honestly reflects it, rather than carrying over a stale tier
            // that no longer matches the actual deviation.
            const actualTier = classifyTier(pick, slotTarget) ?? "p30";
            releasePantryConsumption(rankOpts.pantryTracker, existing.candidate.ingredients);
            markKnownBad(excludedRecipeKeys, existing.candidate.id, slotId.mealType);
            claimResult.claimed[existingIndex] = { slotId, candidate: pick, tier: actualTier };
            commitPantryConsumption(rankOpts.pantryTracker, pick.ingredients);
            // The old add-on (if any -- from addon-at-selection or an
            // earlier phase this same day) was sized against the pre-swap
            // recipe's calories and is no longer relevant to the newly-
            // picked one. Same cleanup as the protein-floor swap below and
            // actions.ts's user-initiated swap path. Also un-mark
            // addonedThisDay so this slot is fairly reconsidered by any
            // later phase this day, same as a slot that never had one.
            //
            // Deliberately NOT re-attempting an addon here (tried live July
            // 20 2026: re-attaching after every swap compounded with the
            // soft-preference above to over-add macros -- worse on every
            // dimension than doing nothing). This phase only reaches an
            // addon'd slot at all when the soft preference above already
            // couldn't find enough non-addon'd slack, so it should stay
            // rare; leaving the slot addon-free after a swap here is the
            // conservative choice.
            addons.delete(slotKey(slotId));
            addonedThisDay.delete(slotKey(slotId));
          }
          // Guard-rejected swaps are discarded, not committed -- but the
          // slot stays marked swapTriedThisDay (above) so the next
          // iteration tries a different slot rather than re-attempting the
          // same non-improving one.
        }
        // If no candidate was found, the slot is still marked
        // swapTriedThisDay for the same reason — never fakes progress that
        // didn't happen.

        gaps = macroGapDirections(sumWithAddons(daySlots(), addons), dailyBand);
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
        //
        // Deliberately NOT guarded by macroDeviationScore improvement (unlike
        // phases 1/2 above, July 20 2026) -- this phase exists to enforce a
        // hard per-meal protein FLOOR (a safety/nutrition requirement), not
        // to optimize weighted accuracy. An addon that pushes a meal over
        // its floor is the correct outcome here even if it costs a few
        // points on the day's overall weighted score elsewhere -- the two
        // goals are genuinely different, not the same check applied twice.
        if (!addonedThisDay.has(slotKey(slotId)) && trySpend(dayRetryBudget, ADDON_ATTEMPT_COST)) {
          retryQueriesUsed++;
          const existing = claimResult.claimed.find((c) => slotKey(c.slotId) === slotKey(slotId));
          addonedThisDay.add(slotKey(slotId));
          if (existing) {
            // Aimed at the floor itself, not the full daily target -- this
            // phase's job is only to clear PROTEIN_FLOOR_FRACTION, not push
            // the meal all the way to its share of the day's protein target.
            const neededAmount = amountNeededFor(existing.candidate.proteinG, proteinFloor);
            const addon = await buildAddonForSlot(existing.candidate.caloriesKcal, floorGap, lookupIngredientMacrosForAddon, dietaryCtx, pantryPriceCtx, neededAmount);
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
            .map((c) => c.candidate.id)
            .concat(knownBadIdsFor(mealType, excludedRecipeKeys));
          const slotTarget = mealTypeTargets[mealType];
          // [floorGap] only, not a broader gaps list -- this phase is a
          // protein-floor top-up specifically; the other 3 macros should
          // stay near their own target rather than get pushed up too just
          // because protein needs to increase (the exact cross-macro-drag
          // bug nudgedBounds was fixed for above, applies here too).
          const bounds = nudgedBounds(slotTarget, [floorGap]);
          const raw = await fetchCandidatesWithCache(
            admin,
            { bounds, tier: existingNow.tier, diet, intolerances, excludeIngredients, type: mealTypeToSpoonacularType(mealType), dietaryStyles: input.dietaryStyles, allergies: input.allergies },
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
            releasePantryConsumption(rankOpts.pantryTracker, existingNow.candidate.ingredients);
            markKnownBad(excludedRecipeKeys, existingNow.candidate.id, mealType);
            claimResult.claimed[idx] = { slotId, candidate: pick, tier: actualTier };
            commitPantryConsumption(rankOpts.pantryTracker, pick.ingredients);
            // The old add-on (if any) was sized against the pre-swap recipe's
            // calories and is no longer relevant to the newly-picked one.
            // Deliberately not re-attempting one here -- see phase 2's swap
            // above for why (live-confirmed to over-add macros).
            addons.delete(slotKey(slotId));
            addonedThisDay.delete(slotKey(slotId));
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

  // AI composition fallback (F3, built July 15 2026) — last resort for
  // whatever's STILL in blockedHints after the entire recipe-search +
  // reconciliation pipeline above (blocked slots never got a claim in the
  // first place, so the day loop above never touches them). Own separate
  // whole-generation budget, not per-day and not shared with
  // reconciliation's budget, since this only ever applies to the rare
  // handful of slots nothing else could fill — found live July 15 2026
  // that an extreme profile's every breakfast (and several lunches) hit
  // this state, not fixable by more Spoonacular query engineering.
  //
  // Same grounding rule as addon.ts/snackComposition.ts: Claude proposes
  // WHAT ingredients (a judgment call), never a macro number — every
  // number here comes from a real Spoonacular ingredient lookup, summed
  // deterministically by composeMealFromProposal. A recoverable failure
  // at ANY step (Claude call fails/misconfigured, proposal fails safety
  // or portion-realism checks, an ingredient doesn't resolve) leaves the
  // slot exactly as blocked as it already was — never partially applied,
  // never forces an unsafe or unrealistic result through.
  // Turns an already-obtained proposal (from either the batch or single-slot
  // path below) into a claimable candidate, or the specific reason it was
  // rejected -- retry-with-feedback (2026-07-30) needs that reason to tell
  // Claude concretely what to fix; reason===null means the rejection was an
  // infra-level failure (quota/outage), not a composition rejection, so
  // there's nothing useful to feed back. Same "stays honestly blocked"
  // contract as before batching was introduced. Shared by every path below
  // so the grounding/pricing/tier math is identical regardless of which one
  // produced the proposal.
  async function composeProposalToCandidateDetailed(
    proposal: NonNullable<Awaited<ReturnType<typeof proposeMealViaClaude>>>,
    slotTarget: MacroTargets,
    key: string,
  ): Promise<{ candidate: RankedCandidate | null; reason: CompositionRejection | null }> {
    // Wrapped July 16 2026 (comprehensive engine test) -- this grounds
    // every proposed ingredient via a real Spoonacular lookup, and used
    // to be the one unguarded call in this whole loop: a quota error here
    // threw uncaught, past every already-claimed slot, and got treated as
    // total generation failure upstream (same bug class as the snack-pool
    // fetch above, and the exact failure mode this file's July 15 fix to
    // the cascade/exhaustion/reconciliation phases never got extended to).
    let result;
    try {
      result = await composeMealFromProposalDetailed(proposal, slotTarget, dietaryCtx, groundIngredientForAiMeal);
    } catch (err) {
      if (!isRecoverableSpoonacularError(err)) throw err;
      console.error(`[mealplan] AI composition grounding failed for ${key} (quota/outage), leaving slot blocked:`, err);
      return { candidate: null, reason: null };
    }
    if (!result.ok) {
      recordAiComposeRejection(result.reason);
      return { candidate: null, reason: result.reason }; // safety/portion-realism/grounding failure -- stays honestly blocked
    }
    const composed = result.meal;

    const actualTier = classifyTier(
      { proteinG: composed.totalProteinG, caloriesKcal: composed.totalCalories },
      slotTarget,
    ) ?? "p30";

    // Real cost now available (staticIngredientMacros.ts confirmed
    // Spoonacular's ingredient endpoint returns real estimatedCost data by
    // default, no extra request needed) — same budgetCompliant definition
    // as everywhere else: only checked when Pro + a budget is set, and an
    // unknown price is never treated as non-compliant.
    // Rounded to an integer -- meal_plan_slots.price_per_serving_cents is an
    // integer column; Spoonacular's own pricePerServing hit this exact same
    // "invalid input syntax for type integer" failure earlier in this
    // project (a float slipped through unrounded) and the fix there was the
    // same: round at the point a real value becomes this column's input.
    const pricePerServingCents = composed.totalEstimatedCostCents !== null ? Math.round(composed.totalEstimatedCostCents) : null;
    const budgetCompliant =
      !pantryPriceCtx.budgetAware || pricePerServingCents === null || budgetPerMealUsd === null || pricePerServingCents <= budgetPerMealUsd * 100;

    return {
      candidate: {
        id: syntheticAiMealId--,
        title: composed.dishName,
        imageUrl: null,
        servings: 1,
        proteinG: composed.totalProteinG,
        caloriesKcal: composed.totalCalories,
        carbsG: composed.totalCarbsG,
        fatG: composed.totalFatG,
        pricePerServingCents,
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
        budgetCompliant,
        actualTier,
        isFallbackOfLastResort: true,
        aiComposed: true,
        // Composed directly to target, not scaled from a fixed-size recipe.
        scaleFactor: 1,
      },
      reason: null,
    };
  }

  // Last-resort fallback (2026-07-30, "fill with the closest meal rather
  // than leaving it open") -- called ONLY after composeProposalToCandidateDetailed
  // has already failed on this EXACT proposal for a non-safety reason (see
  // the call sites below, which never call this on an unsafe_ingredient or
  // no_ingredients rejection -- there's nothing this can salvage from
  // those). Free to call: reuses the SAME already-obtained proposal, no
  // additional Claude call. Mirrors composeProposalToCandidateDetailed's
  // candidate shape exactly; the only difference is which composer runs
  // and that the approximation disclosure is carried onto the candidate.
  async function composeProposalToCandidateBestEffort(
    proposal: NonNullable<Awaited<ReturnType<typeof proposeMealViaClaude>>>,
    slotTarget: MacroTargets,
    key: string,
  ): Promise<RankedCandidate | null> {
    let result;
    try {
      result = await composeMealFromProposalBestEffort(proposal, slotTarget, dietaryCtx, groundIngredientForAiMeal);
    } catch (err) {
      if (!isRecoverableSpoonacularError(err)) throw err;
      console.error(`[mealplan] best-effort AI composition grounding failed for ${key} (quota/outage), leaving slot blocked:`, err);
      return null;
    }
    // Still unsafe, or genuinely nothing to build from -- stays honestly
    // blocked, no further fallback exists past this one.
    if (!result.ok) return null;
    const composed = result.result.meal;

    const actualTier = classifyTier({ proteinG: composed.totalProteinG, caloriesKcal: composed.totalCalories }, slotTarget) ?? "p30";
    const pricePerServingCents = composed.totalEstimatedCostCents !== null ? Math.round(composed.totalEstimatedCostCents) : null;
    const budgetCompliant =
      !pantryPriceCtx.budgetAware || pricePerServingCents === null || budgetPerMealUsd === null || pricePerServingCents <= budgetPerMealUsd * 100;

    if (result.result.isApproximate) {
      console.log(`[mealplan] best-effort fallback used for ${key}: ${result.result.approximationNotes.join("; ")}`);
    }

    return {
      id: syntheticAiMealId--,
      title: composed.dishName,
      imageUrl: null,
      servings: 1,
      proteinG: composed.totalProteinG,
      caloriesKcal: composed.totalCalories,
      carbsG: composed.totalCarbsG,
      fatG: composed.totalFatG,
      pricePerServingCents,
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
      budgetCompliant,
      actualTier,
      isFallbackOfLastResort: true,
      aiComposed: true,
      scaleFactor: 1,
      isApproximate: result.result.isApproximate,
      approximationNotes: result.result.approximationNotes,
    };
  }

  // A rejection this shallow can never be salvaged by the best-effort
  // fallback above -- unsafe_ingredient has no relaxed path by design
  // (see composeMealFromProposalBestEffort's own comment), and
  // no_ingredients means there was never any real data to build from in
  // the first place. Every other kind is worth one best-effort attempt.
  function canAttemptBestEffort(reason: CompositionRejection | null): boolean {
    return reason !== null && reason.kind !== "unsafe_ingredient" && reason.kind !== "no_ingredients";
  }

  // One full propose+compose attempt for a slot -- optionally carrying
  // feedback from a PRIOR rejected attempt on this same slot
  // (mealProposer.ts's priorAttemptFeedback), so a retry isn't a blind
  // re-roll. Returns the same {candidate, reason} shape as
  // composeProposalToCandidateDetailed for the same reason: callers need to
  // know WHY a rejection happened, not just that it did.
  async function proposeAndComposeForSlot(
    slotId: MealSlotId,
    slotTarget: MacroTargets,
    key: string,
    priorAttemptFeedback?: string,
  ): Promise<{ candidate: RankedCandidate | null; reason: CompositionRejection | null; proposal: MealProposal | null }> {
    let proposal;
    try {
      proposal = await proposeMealViaClaude({
        mealType: slotId.mealType as "breakfast" | "lunch" | "dinner",
        target: slotTarget,
        dietaryStyles: input.dietaryStyles,
        allergies: input.allergies,
        dislikes: input.dislikes,
        pantryItemNames,
        priorAttemptFeedback,
        avoidDishNames: usedDishTitles,
      });
    } catch (err) {
      console.error(
        `[mealplan] AI composition call failed for ${key}${priorAttemptFeedback ? " (retry)" : ""}, leaving slot blocked:`,
        err,
      );
      return { candidate: null, reason: null, proposal: null };
    }
    if (!proposal) return { candidate: null, reason: null, proposal: null };
    const result = await composeProposalToCandidateDetailed(proposal, slotTarget, key);
    return { ...result, proposal };
  }

  // De-concentration mitigation (retry-with-feedback, 2026-07-30): a batch
  // dish's OWN target can be Claude's deliberately concentrated per-dish
  // allocation (see the aggregateTarget/ownTarget comment below), not the
  // slot's plain even share. If a portion rejection's gap already exceeds
  // what even the densest realistic real ingredient could deliver at this
  // role's portion cap, retrying with the SAME concentrated target would
  // just repeat the identical, structurally infeasible ask -- reset to the
  // slot's own even share instead. A no-op for a non-batch attempt (where
  // usedTarget and evenShareTarget are already the same object).
  function deconcentrationAdjustedTarget(
    usedTarget: MacroTargets,
    evenShareTarget: MacroTargets,
    reason: CompositionRejection,
  ): MacroTargets {
    if (reason.kind !== "portion_out_of_bounds" && reason.kind !== "portion_infeasible") return usedTarget;
    const ceiling = (PORTION_BOUNDS_G[reason.role].max * bestKnownDensity(reason.role)) / 100;
    return reason.gapNeeded > ceiling ? evenShareTarget : usedTarget;
  }

  // Bounded retry-with-feedback for a single slot, self-contained attempt-1
  // + attempt-2 -- safe to call inline (no cross-slot ordering concern)
  // since it only ever runs for one slot at a time outside the batch loop
  // (tryAiComposeRepair below). The batch loop's own per-dish/per-chunk
  // retries are handled separately (see pendingRetries) so an early slot's
  // retry there can never starve a later slot's first attempt -- see the
  // comment above that loop for why. Spends `budget` only for the retry;
  // the first attempt is the caller's existing, already-established gate
  // (or, for tryAiComposeRepair, deliberately ungated, matching its
  // pre-existing unconditional-first-try behavior).
  async function composeSlotViaAiWithRetry(
    slotId: MealSlotId,
    slotTarget: MacroTargets,
    key: string,
    budget: RetryBudget,
  ): Promise<RankedCandidate | null> {
    const first = await proposeAndComposeForSlot(slotId, slotTarget, key);
    if (first.candidate) return first.candidate;
    if (first.reason === null) return null; // infra-level failure -- no useful feedback to retry with, nothing to salvage either

    let retry: Awaited<ReturnType<typeof proposeAndComposeForSlot>> | null = null;
    if (trySpend(budget, AI_COMPOSE_ACTION_COST)) {
      aiComposeRetryAttempts++;
      const retryTarget = deconcentrationAdjustedTarget(slotTarget, slotTarget, first.reason);
      const feedback = describeRejectionForFeedback(first.reason);
      retry = await proposeAndComposeForSlot(slotId, retryTarget, key, feedback);
      if (retry.candidate) {
        aiComposeRetrySuccesses++;
        return retry.candidate;
      }
    }

    // Last resort (2026-07-30, "fill with the closest meal rather than
    // leaving it open"): neither attempt produced a usable candidate.
    // Try the relaxed composer on whichever proposal we actually have --
    // the retry's (freshest, already informed by feedback) if one fired,
    // else the original. Free: reuses already-obtained data, no
    // additional Claude call. canAttemptBestEffort still refuses this for
    // an unsafe-ingredient or no-data rejection, from either attempt.
    const lastReason = retry?.reason ?? first.reason;
    const lastProposal = retry?.proposal ?? first.proposal;
    if (lastProposal && canAttemptBestEffort(lastReason)) {
      return composeProposalToCandidateBestEffort(lastProposal, slotTarget, key);
    }
    return null;
  }

  // Applies an AI-composed result to its eligible slot -- either a NEW
  // claim (genuinely blocked, claimedIndex undefined) or a REPLACEMENT for
  // an already-claimed bad-fit slot (claimedIndex set, see the widened
  // trigger above). The replacement path is guarded by a "never worse than
  // doing nothing" check, mirroring bestScaleAndScore's own
  // scale=1-always-included guarantee and closing the exact bug class
  // (accepting a "fix" without checking it actually helped) found and
  // fixed elsewhere in this pipeline earlier this session: only swap if
  // the AI-composed pick's macroDeviationScore is strictly lower than what
  // was already claimed. A worse or equal AI-compose result leaves the
  // existing real candidate untouched.
  function applyAiComposeResult(
    entry: { key: string; slotId: MealSlotId; target: MacroTargets; claimedIndex?: number },
    candidate: RankedCandidate | null,
  ): void {
    if (!candidate) return;
    if (entry.claimedIndex === undefined) {
      claimResult.claimed.push({ slotId: entry.slotId, candidate, tier: candidate.actualTier ?? "p30" });
      blockedHints.delete(entry.key);
      // AI-composed candidates are never scored against pantry
      // (aiMealComposition.ts has no pantry awareness of its own), but
      // still committed here -- otherwise a later slot's scoring would
      // see pantry stock as more available than it truly is if this
      // AI-composed pick happens to use some of it too.
      commitPantryConsumption(rankOpts.pantryTracker, candidate.ingredients);
      // Variety/repetition follow-up (2026-07-30): grows the avoid-list so
      // a LATER AI-compose call in this same generation also steers away
      // from what this one just picked.
      usedDishTitles.push(candidate.title);
      return;
    }
    const existing = claimResult.claimed[entry.claimedIndex];
    const existingScore = macroDeviationScore(existing.candidate, entry.target);
    const newScore = macroDeviationScore(candidate, entry.target);
    if (newScore < existingScore) {
      releasePantryConsumption(rankOpts.pantryTracker, existing.candidate.ingredients);
      markKnownBad(excludedRecipeKeys, existing.candidate.id, entry.slotId.mealType);
      claimResult.claimed[entry.claimedIndex] = { slotId: entry.slotId, candidate, tier: candidate.actualTier ?? "p30" };
      commitPantryConsumption(rankOpts.pantryTracker, candidate.ingredients);
      usedDishTitles.push(candidate.title);
    }
  }

  // Batch-aware AI composition (added 2026-07-20) -- a genuinely blocked
  // slot is never alone by the time this fallback fires (it only runs on
  // whatever the entire recipe-search+reconciliation pipeline already gave
  // up on), so the old one-call-per-slot version solved every slot in
  // total isolation from every other one still blocked in the SAME
  // generation. Batches them into ONE Claude call with the combined target
  // across the group (see mealProposer.ts's proposeMealsBatchViaClaude),
  // so Claude can lean higher-protein on one dish and lower on another
  // instead of forcing each dish to independently hit its own narrow
  // share. Falls back to the original per-slot path (never just gives up)
  // if the batch call errors or returns something unusable.
  // claimedIndex is set only for a slot that ALREADY has a real candidate
  // claimed (see the bad-fit pass below) -- distinguishes "genuinely
  // blocked, add a new claim" from "already claimed, only replace if
  // AI-compose demonstrably improves on it" in the result-handling below.
  // Real count of blocked recipe slots this generation (free to compute —
  // no API cost), feeding the adaptive budget below. Computed upfront, not
  // incremented inside the loop below, so a mid-loop break from budget
  // exhaustion can't undercount the slots never even reached.
  const blockedRecipeSlotCount = [...blockedHints.keys()].filter((key) => {
    const slotId = allSlots.find((s) => slotKey(s) === key);
    return slotId && slotMechanism(slotId.mealType) === "recipe";
  }).length;

  // Variety/repetition follow-up (2026-07-30, same comprehensive audit that
  // found the carb/protein-pool gaps): the plan critic independently
  // flagged real dish-level repetition even on an UNRESTRICTED profile
  // ("heavy repetition of the Seitan Stir-Fry with Rice and Broccoli
  // lunch, 4 of 7 days") -- real recipes can't literally repeat (claim.ts
  // already dedupes by id across the whole generation), so this has to be
  // the AI-compose path proposing the same obvious dish repeatedly, since
  // separate propose calls have no memory of each other. Seeded from every
  // title already claimed by the time AI-compose starts (real recipes AND
  // composed snacks), then grown as AI-compose itself claims more, so a
  // LATER call in this same generation also avoids what an EARLIER
  // AI-compose call already picked, not just what real-recipe search found.
  const usedDishTitles: string[] = claimResult.claimed.map((c) => c.candidate.title);
  const aiComposeBudget = createAiComposeBudget(blockedRecipeSlotCount);
  const eligible: Array<{ key: string; slotId: MealSlotId; target: MacroTargets; claimedIndex?: number; budget: RetryBudget }> = [];
  // Genuinely blocked slots draw from their own existing, already-tuned
  // budget, unchanged from before this pass existed.
  for (const [key] of [...blockedHints.entries()]) {
    const slotId = allSlots.find((s) => slotKey(s) === key);
    // Snack slots are composed separately above and never end up in
    // blockedHints via this path in practice, but guard explicitly rather
    // than assume — this fallback is scoped to recipe-mechanism slots.
    if (!slotId || slotMechanism(slotId.mealType) !== "recipe") continue;
    if (!trySpend(aiComposeBudget, AI_COMPOSE_ACTION_COST)) break;
    eligible.push({ key, slotId, target: mealTypeTargets[slotId.mealType], budget: aiComposeBudget });
  }

  // Widened trigger (2026-07-21 spec): a slot with at least one real
  // candidate isn't "blocked" by resolveClaims's own definition, so it
  // never reached the loop above no matter how bad that candidate's fit
  // is. Real cached-pool survey found this is a real, sizeable gap -- 22
  // thin pools (1-4 real candidates) scoring ~4.6x worse on average than a
  // healthy pool, none of which ever got an AI-compose chance. actualTier
  // === null (outside even p30) reuses an already-meaningful boundary
  // rather than inventing a new threshold. Only ever REPLACES the existing
  // claim, and only if AI-compose demonstrably scores better (see the
  // never-regress check in both result branches below) -- this can only
  // improve a slot's accuracy, never make an already-claimed slot worse.
  //
  // Draws from its OWN separate budget (createBadFitSwapBudget), not the
  // blocked-slot budget above. Found live 2026-07-21: sharing one budget
  // meant a profile with many blocked slots (stacked-safety hit 14) could
  // exhaust it entirely before this pass ever ran -- the identical 2
  // bad-fit-claimed slots got starved 3 live runs in a row, even though
  // detection itself (this loop, no API cost) found them every time. A
  // separate, smaller, additive budget guarantees this pass always gets a
  // real chance, regardless of how many slots are blocked that week.
  // Sized to the REAL count of null-tier recipe slots found this generation
  // (free to compute -- classifyTier returning null, no API cost) rather
  // than a flat guess -- see retryBudget.ts's createBadFitSwapBudget for
  // why (live-confirmed a diet-restricted profile can have far more than
  // the "typical" 1-3 thin-pool slots the old flat budget assumed).
  const nullTierRecipeCount = claimResult.claimed.filter(
    (c) => slotMechanism(c.slotId.mealType) === "recipe" && c.candidate.actualTier === null,
  ).length;
  const badFitSwapBudget = createBadFitSwapBudget(nullTierRecipeCount);
  for (const [claimedIndex, c] of claimResult.claimed.entries()) {
    if (slotMechanism(c.slotId.mealType) !== "recipe") continue;
    if (c.candidate.actualTier !== null) continue;
    if (!trySpend(badFitSwapBudget, AI_COMPOSE_ACTION_COST)) break;
    eligible.push({ key: slotKey(c.slotId), slotId: c.slotId, target: mealTypeTargets[c.slotId.mealType], claimedIndex, budget: badFitSwapBudget });
  }

  // Retry-with-feedback (2026-07-30): rejections from pass 1 below are
  // deferred here rather than retried inline, in the SAME order eligible
  // was built, so a rejected early slot's retry can never spend budget a
  // later slot still needs for its own FIRST attempt -- that ordering
  // guarantee has priority over giving any single slot its second try
  // sooner. Drained in one sweep after the whole chunked loop finishes.
  const pendingRetries: Array<{
    entry: (typeof eligible)[number];
    reason: CompositionRejection;
    usedTarget: MacroTargets;
    proposal: MealProposal;
  }> = [];

  // Chunked into groups of MAX_AI_COMPOSE_BATCH_SIZE (2026-07-28) -- each
  // chunk gets its own batch call/aggregateTarget/fallback, exactly as if
  // it were the only group this generation, so a wider `eligible` (now
  // possible with the adaptive bad-fit-swap budget above) can't dilute any
  // one call's "concentrate protein" guidance across too many slots.
  for (let chunkStart = 0; chunkStart < eligible.length; chunkStart += MAX_AI_COMPOSE_BATCH_SIZE) {
    const chunk = eligible.slice(chunkStart, chunkStart + MAX_AI_COMPOSE_BATCH_SIZE);

    const aggregateTarget = chunk.reduce<MacroTargets>(
      (sum, e) => ({
        calories: sum.calories + e.target.calories,
        proteinG: sum.proteinG + e.target.proteinG,
        carbsG: sum.carbsG + e.target.carbsG,
        fatG: sum.fatG + e.target.fatG,
      }),
      { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
    );

    let batchProposals: Awaited<ReturnType<typeof proposeMealsBatchViaClaude>> = null;
    try {
      batchProposals = await proposeMealsBatchViaClaude({
        slots: chunk.map((e) => ({ mealType: e.slotId.mealType as "breakfast" | "lunch" | "dinner", target: e.target })),
        aggregateTarget,
        dietaryStyles: input.dietaryStyles,
        allergies: input.allergies,
        dislikes: input.dislikes,
        pantryItemNames,
        avoidDishNames: usedDishTitles,
      });
    } catch (err) {
      console.error(`[mealplan] batch AI composition call failed, falling back to per-slot:`, err);
    }

    if (batchProposals && batchProposals.length === chunk.length) {
      for (let i = 0; i < chunk.length; i++) {
        const entry = chunk[i];
        // Sizes against THIS dish's own rescaled target (Claude's
        // deliberate per-dish allocation, corrected to sum exactly to the
        // aggregate) rather than the flat per-slot share -- this is what
        // actually makes the batch prompt's "concentrate protein into
        // fewer dishes" guidance take effect downstream, added 2026-07-20
        // after finding the redistribution was previously promised in the
        // prompt but never wired through to the sizing math. The
        // never-regress comparison in applyAiComposeResult still scores
        // against entry.target (the slot's own real per-meal-type target),
        // not this internal rescaled allocation.
        const { proposal, target: ownTarget } = batchProposals[i];
        const { candidate, reason } = await composeProposalToCandidateDetailed(proposal, ownTarget, entry.key);
        if (candidate) {
          applyAiComposeResult(entry, candidate);
        } else if (reason) {
          // This dish's own proposal was rejected (safety/portion-realism/
          // grounding failure) even though the rest of the batch succeeded --
          // queue it for a fed-back retry (see pendingRetries above) instead
          // of leaving the slot blocked outright or blindly re-rolling.
          pendingRetries.push({ entry, reason, usedTarget: ownTarget, proposal });
        }
        // reason === null (infra-level failure) -- nothing useful to retry
        // with, slot stays honestly blocked, same as before this pass.
      }
    } else {
      // Batch attempt didn't produce a usable result (network error,
      // malformed tool call, wrong count) -- fall back to the original
      // one-call-per-slot path for every slot still in this chunk, exactly
      // as if batching had never been attempted.
      for (const entry of chunk) {
        const { candidate, reason, proposal } = await proposeAndComposeForSlot(entry.slotId, entry.target, entry.key);
        if (candidate) {
          applyAiComposeResult(entry, candidate);
        } else if (reason && proposal) {
          pendingRetries.push({ entry, reason, usedTarget: entry.target, proposal });
        }
      }
    }
  }

  // Pass 2: one fed-back retry per rejected slot, in the same order pass 1
  // rejected them, each spending its OWN originating budget (aiCompose or
  // bad-fit-swap) via the same trySpend already used for every attempt in
  // this pass. Running this AFTER the entire chunked loop above (rather
  // than inline per-chunk) is what gives every slot's first attempt
  // priority over any slot's retry, regardless of chunk order.
  for (const { entry, reason, usedTarget, proposal } of pendingRetries) {
    let candidate: RankedCandidate | null = null;
    let lastReason: CompositionRejection | null = reason;
    let lastProposal: MealProposal = proposal;

    if (trySpend(entry.budget, AI_COMPOSE_ACTION_COST)) {
      aiComposeRetryAttempts++;
      const retryTarget = deconcentrationAdjustedTarget(usedTarget, entry.target, reason);
      const feedback = describeRejectionForFeedback(reason);
      const retry = await proposeAndComposeForSlot(entry.slotId, retryTarget, entry.key, feedback);
      candidate = retry.candidate;
      if (candidate) aiComposeRetrySuccesses++;
      // Keep whichever reason/proposal is freshest for the best-effort
      // fallback below -- the retry's if it actually ran and produced one,
      // else fall back to what pass 1 already gave us.
      if (retry.reason !== null) lastReason = retry.reason;
      if (retry.proposal) lastProposal = retry.proposal;
    }

    // Last resort (2026-07-30, "fill with the closest meal rather than
    // leaving it open"): the retry either didn't fire (budget exhausted)
    // or also failed. Free -- reuses already-obtained data, no additional
    // Claude call. Never fires for an unsafe-ingredient or no-data
    // rejection; see canAttemptBestEffort's own comment.
    if (!candidate && canAttemptBestEffort(lastReason)) {
      candidate = await composeProposalToCandidateBestEffort(lastProposal, entry.target, entry.key);
    }
    applyAiComposeResult(entry, candidate);
  }

  // Pass 3 (2026-07-30, "fill with the closest meal rather than leaving it
  // open"): any recipe-mechanism slot STILL in blockedHints at this point
  // never got a first AI-compose attempt at all -- the eligibility loop
  // that builds `eligible` above stops (`break`) the moment its own
  // budget runs out, so every slot after that point in iteration order
  // never entered the pipeline above, pass 2 included. Live-confirmed:
  // an entire day's worth of slots blocked this way, not a rejection
  // anywhere -- pass 2's best-effort fallback had nothing to salvage for
  // them since they never got a proposal in the first place. A small,
  // dedicated last-resort budget (sized to exactly what's left, one
  // attempt each, no retry -- budget was already the problem) gives
  // every remaining slot one real shot, going straight to best-effort on
  // whatever that attempt produces rather than requiring a second perfect
  // try. Real API cost (a genuine Claude call per remaining slot), so
  // still bounded, just not zero -- see the equivalent tradeoff already
  // accepted for tryAiComposeRepair's own small dedicated budget below.
  const stillBlockedRecipeSlots = [...blockedHints.keys()]
    .map((key) => allSlots.find((s) => slotKey(s) === key))
    .filter((slotId): slotId is MealSlotId => !!slotId && slotMechanism(slotId.mealType) === "recipe");

  if (stillBlockedRecipeSlots.length > 0) {
    const lastResortBudget = createRetryBudget(AI_COMPOSE_ACTION_COST * stillBlockedRecipeSlots.length);
    for (const slotId of stillBlockedRecipeSlots) {
      const key = slotKey(slotId);
      if (!trySpend(lastResortBudget, AI_COMPOSE_ACTION_COST)) break;
      const slotTarget = mealTypeTargets[slotId.mealType];
      const attempt = await proposeAndComposeForSlot(slotId, slotTarget, key);
      let candidate = attempt.candidate;
      if (!candidate && attempt.proposal && canAttemptBestEffort(attempt.reason)) {
        candidate = await composeProposalToCandidateBestEffort(attempt.proposal, slotTarget, key);
      }
      applyAiComposeResult({ key, slotId, target: slotTarget }, candidate);
    }
  }

  // Last-resort fallback for a flagged diet_violation with no real recipe
  // alternative (added July 16 2026) -- scoped to a single already-claimed
  // slot instead of an exhausted blockedHints entry, and returns null on
  // ANY failure rather than partially applying anything, so the caller can
  // fall through to disclosure (unresolvedDietaryConcerns) instead of
  // guessing why it failed. Now routed through composeSlotViaAiWithRetry
  // (2026-07-30 retry-with-feedback) instead of hand-rolling its own
  // propose+compose+build-candidate sequence -- this call site never had
  // any budget gating before (always tried unconditionally, this is a
  // rare, safety-critical repair, not a per-slot loop), so it gets a small
  // local budget sized for exactly its own first attempt + one retry
  // rather than sharing (and being starved by) the whole-generation
  // AI-compose budget above, which has already been fully spent by the
  // time this later repair pass runs.
  async function tryAiComposeRepair(slotId: MealSlotId, slotTarget: MacroTargets): Promise<RankedCandidate | null> {
    const repairBudget = createRetryBudget(AI_COMPOSE_ACTION_COST * MAX_AI_COMPOSE_ATTEMPTS_PER_SLOT);
    return composeSlotViaAiWithRetry(slotId, slotTarget, slotKey(slotId), repairBudget);
  }

  // Slots a diet_violation flag couldn't be resolved for even after both
  // the real-recipe swap attempt and the AI-composition fallback above --
  // surfaced to the caller rather than silently kept, same "disclose,
  // don't silently under-filter" precedent as dietaryMapping.ts's
  // unsupportedDietaryStyles (halal/kosher). Expected to be empty in the
  // overwhelming majority of plans; only ever populated for a genuine,
  // unresolvable safety flag, never for repetitive/macro_miss/other.
  const unresolvedDietaryConcerns: Array<{ dayIndex: number; mealType: string; note: string }> = [];
  // Previously computed every generation but only ever console.log'd below
  // -- null whenever the critique itself is skipped/fails (no
  // ANTHROPIC_API_KEY, or a recoverable API error), same as today's
  // existing graceful-skip behavior for the repair pass it feeds.
  let weeklyAssessment: string | null = null;

  // Post-generation plan critique + repair (built July 15 2026, extended
  // July 16 2026 with diet_violation) — the per-slot pipeline above never
  // sees the whole week at once, so it structurally can't notice cross-
  // cutting problems like "this exact recipe shows up 4 times," or check
  // for the kind of hidden/foreign-language violation the deterministic
  // keyword gates (ingredientSafety.ts/openEndedIngredientSafety.ts)
  // structurally can't enumerate. One Claude call reviews the full plan
  // and flags specific slots worth a second look; every flagged slot then
  // gets a REAL swap attempt via the existing swapSlotCandidate
  // mechanism, and the accept/reject decision is 100% deterministic
  // (planRepair.ts's shouldAcceptRepair, using real macro-deviation
  // scores, EXCEPT diet_violation which always accepts a real alternative
  // regardless of score) — the critic only decides what to reconsider,
  // never what's "better." Skipped entirely, gracefully, if no
  // ANTHROPIC_API_KEY is configured or the call fails for any reason —
  // this is a polish pass on an already-complete plan, never something
  // that can leave the plan worse or incomplete than before this phase
  // ran.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const planSummary: PlanSlotSummary[] = claimResult.claimed.map((c) => {
        const addon = addons.get(slotKey(c.slotId));
        return {
          dayIndex: c.slotId.dayIndex,
          mealType: c.slotId.mealType,
          title: c.candidate.title,
          proteinG: c.candidate.proteinG + (addon?.proteinG ?? 0),
          caloriesKcal: c.candidate.caloriesKcal + (addon?.caloriesKcal ?? 0),
          carbsG: c.candidate.carbsG + (addon?.carbsG ?? 0),
          fatG: c.candidate.fatG + (addon?.fatG ?? 0),
          isComposed: c.candidate.id < 0,
          ingredients: addon
            ? [...c.candidate.ingredients.map((i) => i.name), addon.ingredientName]
            : c.candidate.ingredients.map((i) => i.name),
        };
      });

      // Excludes halal/kosher (unsupportedDietaryStyles) before the critic
      // ever sees them -- confirmed live (2026-07-22 comprehensive test)
      // that asking Claude to check these produces an inconsistent safety
      // signal: it sometimes catches a real violation (e.g. a pork dish),
      // but the deterministic repair swap below has no kosher/halal
      // awareness at all (dietaryMapping.ts maps both to {}, so neither
      // Spoonacular's diet/intolerance filters nor swapSlotCandidate's
      // query reflect them), and diet_violation flags always accept
      // whatever real alternative comes back regardless of fit. That
      // swap can land on an equally non-compliant dish, which looks like
      // a worse failure than never having flagged it -- partial
      // enforcement that then fails to enforce is more misleading than
      // the honest "disclosure only, not filtered" stance the rest of
      // the app already takes for these two styles.
      const enforceableDietaryStyles = input.dietaryStyles.filter(
        (style) => !unsupportedDietaryStyles([style]).length,
      );

      const critique = await critiquePlan({
        slots: planSummary,
        weeklyTarget: weekly,
        dietaryStyles: enforceableDietaryStyles,
        allergies: input.allergies,
        dislikes: input.dislikes,
      });

      if (critique) {
        weeklyAssessment = critique.overallAssessment;
        console.log(
          `[mealplan] plan critique: ${critique.overallAssessment} (${critique.flaggedSlots.length} slots flagged)`,
        );
        const repairBudget = createPlanRepairBudget();

        // diet_violation flags process first so the shared, capped repair
        // budget can't let cosmetic (repetitive/macro_miss/other) repairs
        // starve a genuine safety fix earlier in the list — safety
        // shouldn't depend on array order.
        const sortedFlags = [...critique.flaggedSlots].sort(
          (a, b) => (a.reason === "diet_violation" ? 0 : 1) - (b.reason === "diet_violation" ? 0 : 1),
        );

        // Dedupes flags pointing at the same slot -- found July 16 2026
        // (comprehensive engine test): a critique response flagging the
        // same (dayIndex, mealType) twice (e.g. once as macro_miss, once
        // as diet_violation) used to spend 2 of the shared 5-slot repair
        // budget on one meal instead of 1, reducing how many distinct
        // slots a plan's repair pass can actually address. Checked before
        // spending any budget, not just before acting, so a duplicate
        // costs nothing.
        const processedFlagSlots = new Set<string>();

        for (const flag of sortedFlags) {
          const flagSlotKey = `${flag.dayIndex}-${flag.mealType}`;
          if (processedFlagSlots.has(flagSlotKey)) continue;
          processedFlagSlots.add(flagSlotKey);

          if (!trySpend(repairBudget, RECIPE_ACTION_COST)) break;

          const idx = claimResult.claimed.findIndex(
            (c) => c.slotId.dayIndex === flag.dayIndex && c.slotId.mealType === flag.mealType,
          );
          if (idx === -1) continue;
          const existing = claimResult.claimed[idx];

          // Snacks and AI-composed meals aren't swapped by this pass —
          // the critic is prompted not to flag composed snacks for
          // repetition, and re-running the AI composition path here would
          // spend a second Claude call per flagged slot on a case that
          // already went through its own dedicated fallback above. A
          // diet_violation flag on one of these should be rare (both
          // mechanisms already run through their own safety gate at claim
          // time) but is disclosed rather than silently dropped.
          if (slotMechanism(existing.slotId.mealType) !== "recipe" || existing.candidate.aiComposed) {
            if (flag.reason === "diet_violation") {
              unresolvedDietaryConcerns.push({ dayIndex: flag.dayIndex, mealType: flag.mealType, note: flag.note });
            }
            continue;
          }

          const otherTitlesInPlan = claimResult.claimed.filter((_, i) => i !== idx).map((c) => c.candidate.title);
          // Excludes every recipe already used anywhere in the plan, not
          // just this slot's own — prevents the repair from accidentally
          // trading one duplicate for a brand-new one elsewhere. Also
          // excludes anything already removed elsewhere this generation for
          // being a confirmed bad fit (excludedRecipeKeys) -- this is the
          // exact site that live-confirmed a recipe correctly removed by
          // the bad-fit-swap pass earlier could otherwise get pulled back
          // in here, since diet_violation repairs bypass the macro check
          // below by design and had no memory of what was already rejected.
          const excludeRecipeIds = claimResult.claimed
            .map((c) => c.candidate.id)
            .concat(knownBadIdsFor(existing.slotId.mealType, excludedRecipeKeys));
          const slotTarget = mealTypeTargets[existing.slotId.mealType];

          let swapResult;
          try {
            swapResult = await swapSlotCandidate({
              dailyTargets: input.dailyTargets,
              mealType: existing.slotId.mealType,
              dietaryStyles: input.dietaryStyles,
              allergies: input.allergies,
              dislikes: input.dislikes,
              tier: input.tier,
              weeklyBudgetUsd: input.weeklyBudgetUsd,
              excludeRecipeIds,
              pantryItems: input.pantryItems,
              pantryTracker: rankOpts.pantryTracker,
            });
          } catch (err) {
            if (!isRecoverableSpoonacularError(err)) throw err;
            console.error(`[mealplan] repair swap failed for day ${flag.dayIndex} ${flag.mealType}, keeping original:`, err);
            if (flag.reason === "diet_violation") {
              unresolvedDietaryConcerns.push({ dayIndex: flag.dayIndex, mealType: flag.mealType, note: flag.note });
            }
            continue;
          }

          if (swapResult.blocked || !swapResult.candidate) {
            // No real recipe alternative exists. A cosmetic flag just
            // keeps the original (unchanged behavior) — but a genuine
            // safety flag never just keeps a known violation. Try the
            // same AI-composition last resort already used earlier in
            // generation for exhausted cascades (its own independent
            // safety gate, not constrained to Spoonacular's corpus)
            // before disclosing it as unresolved.
            if (flag.reason === "diet_violation") {
              const composed = await tryAiComposeRepair(existing.slotId, slotTarget);
              if (composed) {
                releasePantryConsumption(rankOpts.pantryTracker, existing.candidate.ingredients);
                markKnownBad(excludedRecipeKeys, existing.candidate.id, existing.slotId.mealType);
                claimResult.claimed[idx] = { slotId: existing.slotId, candidate: composed, tier: composed.actualTier ?? "p30" };
                // AI-composed -- not scored against pantry, still
                // committed so a later slot doesn't see stock as more
                // available than it truly is (same rationale as
                // applyAiComposeResult above).
                commitPantryConsumption(rankOpts.pantryTracker, composed.ingredients);
                usedDishTitles.push(composed.title);
                addons.delete(slotKey(existing.slotId));
                console.log(
                  `[mealplan] repair accepted (diet_violation, AI-composed) for day ${flag.dayIndex} ${flag.mealType}: ` +
                    `"${existing.candidate.title}" -> "${composed.title}"`,
                );
              } else {
                unresolvedDietaryConcerns.push({ dayIndex: flag.dayIndex, mealType: flag.mealType, note: flag.note });
                console.error(
                  `[mealplan] no safe alternative found for flagged diet_violation, day ${flag.dayIndex} ${flag.mealType}: ${flag.note}`,
                );
              }
            }
            continue;
          }

          const oldScore = macroDeviationScore(existing.candidate, slotTarget);
          const newScore = macroDeviationScore(swapResult.candidate, slotTarget);

          const accept = shouldAcceptRepair({
            reason: flag.reason,
            oldScore,
            newScore,
            otherTitlesInPlan,
            newCandidateTitle: swapResult.candidate.title,
          });

          if (accept) {
            const actualTier = swapResult.tier ?? existing.tier;
            releasePantryConsumption(rankOpts.pantryTracker, existing.candidate.ingredients);
            markKnownBad(excludedRecipeKeys, existing.candidate.id, existing.slotId.mealType);
            claimResult.claimed[idx] = { slotId: existing.slotId, candidate: swapResult.candidate, tier: actualTier };
            commitPantryConsumption(rankOpts.pantryTracker, swapResult.candidate.ingredients);
            // A swapped recipe invalidates any add-on sized for the meal
            // it's replacing — same rule as the user-facing swap action
            // (actions.ts's swapMeal).
            addons.delete(slotKey(existing.slotId));
            console.log(
              `[mealplan] repair accepted for day ${flag.dayIndex} ${flag.mealType} (${flag.reason}): ` +
                `"${existing.candidate.title}" -> "${swapResult.candidate.title}"`,
            );
          }
        }
      }
    } catch (err) {
      console.error("[mealplan] plan critique/repair failed, keeping plan as generated:", err);
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
      `retryQueriesUsed=${retryQueriesUsed}, reconciliation=${reconciliationStatus}, ` +
      `unresolvedDietaryConcerns=${unresolvedDietaryConcerns.length}`,
  );
  console.log(
    `[mealplan] AI-compose retry-with-feedback: rejections=${JSON.stringify(aiComposeRejectionCounts)}, ` +
      `retryAttempts=${aiComposeRetryAttempts}, retrySuccesses=${aiComposeRetrySuccesses}`,
  );

  return {
    slots,
    blockedSlots,
    reconciliationStatus,
    retryQueriesUsed,
    weeklyTarget: weekly,
    weeklyActual: actual,
    unresolvedDietaryConcerns,
    weeklyAssessment,
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
  // NOT part of the cache key, same reasoning as excludeIds below -- the
  // raw F2 preset list, carried through purely for the post-read safety
  // backstop (see dietaryCtx below), not for querying Spoonacular (that's
  // already done via diet/intolerances above).
  dietaryStyles: string[];
  // NOT part of the cache key, same reasoning as dietaryStyles above -- the
  // raw, un-merged allergy list, carried through purely for the post-read
  // safety backstop. Found live July 20 2026: without this, dietaryCtxFor
  // below had no way to tell a real allergy apart from a dislike (both
  // arrive pre-merged into excludeIngredients for the Spoonacular query),
  // so it hardcoded allergies to [] and passed the whole merged list as
  // dislikes -- silently downgrading every real allergy to "dislike"
  // severity for this check. openEndedIngredientSafety.ts's category-wide
  // synonym expansion (nuts/dairy/soy/etc.) is deliberately allergy-only,
  // never dislike-only (a dislike of "blue cheese" must not block all
  // dairy) -- so that downgrade meant a declared "tree nuts" allergy never
  // caught "almond meal" in a real recipe's ingredients, only an exact
  // "tree nuts" phrase match. Confirmed live: exactly this leak, on the
  // stacked-safety profile (5 allergies incl. tree nuts).
  allergies: string[];
}

// Real recipe-search gap found live July 15 2026 (audit round 3):
// Spoonacular's own diet=vegetarian/vegan tag can be wrong -- live-
// sampled real "vegetarian"-tagged recipes and found real animal-product
// violations (e.g. "chicken broth" in a recipe Spoonacular itself tags
// vegetarian) at a real, recurring rate (~2-6% across samples, not a
// one-off). Composed snacks/add-ons already had a local safety backstop
// (ingredientSafety.ts) on top of Spoonacular's own filtering; real
// recipes had none at all until now -- this closes that asymmetry using
// the same word-boundary-and-plant-modifier-aware matcher already fixed
// in openEndedIngredientSafety.ts for the AI-composition path, reused
// here rather than writing a third keyword-matching implementation.
// Applied AFTER the cache read (like excludeIds below), not baked into
// what gets cached, so the cache always stores Spoonacular's real
// response and this filter can be tightened later without invalidating
// anything.
function dietaryCtxFor(query: CacheableQuery): DietaryContext {
  return { dietaryStyles: query.dietaryStyles, allergies: query.allergies, dislikes: query.excludeIngredients };
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
  const dietaryCtx = dietaryCtxFor(query);
  // Title check added 2026-07-27, alongside the pre-existing ingredient
  // check -- closes a real, live-confirmed gap where Spoonacular's own
  // structured ingredients for a recipe don't mention a meat/shellfish the
  // TITLE names (e.g. a "Ham and Swiss Panini" whose real ingredient list
  // never mentions ham). Applied at this one choke point so every
  // recipe-candidate fetch benefits (initial generation, reconciliation
  // swaps, repair swaps, user-initiated swaps), not just the repair path
  // where the gap was first found.
  return raw.filter(
    (c) =>
      !exclude.has(c.id) &&
      anyIngredientUnsafeFor(c.ingredients.map((i) => i.name), dietaryCtx) === null &&
      isRecipeTitleUnsafeFor(c.title, dietaryCtx) === null,
  );
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
  // Optional: a tracker reflecting pantry consumption already known to the
  // caller. Two callers supply one, at different resolution tiers:
  // critic-repair's own call site below passes a LIVE, already-depleted,
  // LLM/unit-conversion-RESOLVED tracker reused from its in-progress
  // orchestrateGeneration pass. The standalone "swap this meal" user
  // action (actions.ts's swapMeal) instead builds an UNRESOLVED one via
  // buildTrackerFromKnownConsumption (pantryRemaining.ts), committing the
  // rest of the current plan's slots' ingredients into it -- same-
  // category/id/namesOverlap matching only, no LLM/network calls, so no
  // added latency versus a plain swap. Full LLM-resolved parity for the
  // swap's OWN candidate set remains deliberately out of scope (would
  // require restructuring this function's fetch-then-rank flow to insert
  // a resolve step, and would reintroduce cold-cache latency on what's
  // otherwise an instant single-click action) -- revisit only if usage
  // data shows fuzzy-name/cross-unit pantry mismatches are common enough
  // in swaps specifically to justify it. Omitting this argument entirely
  // falls back to an UNRESOLVED tracker built fresh from `pantryItems`
  // alone, with no other-slot consumption committed either -- today's
  // original boolean-only behavior, never a regression for any caller.
  pantryTracker?: PantryRemainingTracker;
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
    const pool = await fetchSnackIngredientPool({
      dietaryStyles: input.dietaryStyles,
      allergies: input.allergies,
      dislikes: input.dislikes,
    });
    const varietySeed = Date.now() % 3;
    const swapBudgetPerMealUsd = input.weeklyBudgetUsd !== null ? input.weeklyBudgetUsd / MEALS_PER_WEEK : null;
    const swapPantryPriceCtx: PantryPriceContext = {
      pantryItemNames: input.pantryItems.map((p) => p.name),
      budgetAware: input.tier === "pro" && swapBudgetPerMealUsd !== null,
    };
    const candidate = composedSnackCandidate(perMeal, pool, varietySeed, -1, swapPantryPriceCtx, swapBudgetPerMealUsd);
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
      { bounds, tier, diet, intolerances, excludeIngredients, type: mealTypeToSpoonacularType(input.mealType), dietaryStyles: input.dietaryStyles, allergies: input.allergies },
      input.excludeRecipeIds,
      inFlight,
    );

  const pantryTracker = input.pantryTracker ?? buildPantryRemainingTracker(input.pantryItems, new Map());
  const cascade = await runCascadeForSlot(perMeal, fetcher, {
    tier: input.tier,
    budgetPerMealUsd,
    pantryTracker,
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
