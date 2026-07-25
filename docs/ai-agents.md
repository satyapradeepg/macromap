# MacroMap — AI Agents

> How will your product use AI?

**Stage:** Pre-seed | **Date:** July 2026

---

## Overview

MacroMap is built as an **AI agent system** — a central orchestrator (Claude) coordinates a set of specialised MCP (Model Context Protocol) agents, each owning one data domain. The orchestrator reasons across all agents simultaneously to produce contextual recommendations that no single data source could generate alone.

**Architecture update (pantry-first, conversational, AI-composed recipes):** three changes to the original design, all folded into the sections below. (1) Pantry contents are now read *before* recipe queries fire, not just used to filter the grocery list afterward — this moves Pantry Agent data (previously V2-only) into the MVP critical path. (2) The Orchestrator is now a persistent, conversational session across the whole flow, not a one-shot trigger on "Generate" / "Swap" — the user can edit pantry, swap meals, or change constraints in plain language at any point. (3) When Spoonacular search can't produce an acceptable recipe (cascade exhausted, or pantry ingredients ignored), Claude can compose or edit a recipe, and can attach a small snack/add-on to a meal to close a macro gap — in both cases every macro number is still resolved from Spoonacular's ingredient-level nutrition data, never estimated by the LLM. See Agent 1, Agent 2, and Agent 4 below, and PRD F3/F6/F11.

**Fourth change, added July 15 2026: post-generation plan critique.** After a plan is fully generated, one more Claude call reviews the whole week at once and flags slots worth reconsidering — repetitive recipes, or a meal that's a notably worse macro fit than the rest of the week. Every flagged slot's actual fate is still decided deterministically (a real alternative, scored and compared, never just trusted). See Agent 1's new bullet and Agent 2's repair note below. Both this and (3) above are currently gated behind `ANTHROPIC_API_KEY`, which is not yet configured in the working environment — deferred by explicit decision this session, not an oversight; the deterministic logic around both has been built, tested, and in the critique's case verified against a real generated plan by manually standing in for the LLM call.

**Fifth change, built + live-tested July 2026: grocery list quantities and pricing, both corrected against real data.** Two deterministic fixes, no LLM involved in either: (a) each grocery ingredient's quantity now correctly reflects *only* the portion actually planned for that meal — scaled by the same per-slot macro-fit factor Agent 2 already computes, divided by the recipe's native serving count (Spoonacular's ingredient amounts are for the whole recipe batch, not one serving) — live-tested to cut one real plan's grocery total from an implausible $1,085 to a plausible $140.78; (b) Agent 3 (Price Agent) switched from Tavily-first to Spoonacular-first for the reason described in its own section below. Pantry exclusion (Agent 4) also gained an optional quantitative mode alongside its original all-or-nothing behavior. See F4/F6 in the PRD and Agent 3/Agent 4 below.

```
User Goal Input
      │
      ▼
┌─────────────────────────────────────────────────────┐
│              Orchestrator Agent (Claude)             │
│  Holds the full context: goal + constraints +       │
│  pantry + budget + preferences + prior ratings      │
└──────┬────────────┬──────────────┬──────────────────┘
       │            │              │
       ▼            ▼              ▼
 Recipe Agent      Price Agent        Pantry Agent
 (Spoonacular)  (Spoonacular + Tavily)  (Custom MCP)
```

---

## Agent 1 — Orchestrator (Claude)

**Role:** The central reasoning layer. Receives the user's weekly goal and coordinates all downstream agents to produce the meal plan, grocery list, and nutrition summary.

**What it does:**
- Accepts user inputs: macro targets, budget, dietary preferences, allergies, pantry contents, prior meal ratings
- Reads Pantry Agent contents *before* querying recipes (moved up from V2 — see Agent 4) and passes them to the Recipe Agent as a soft preference, biasing candidate selection toward on-hand ingredients without overriding any hard constraint
- Decides which recipes to query (what constraints to pass to the Recipe Agent)
- Applies the cascade tolerance fallback (±10% → ±20% → ±30%) when no recipe matches
- Fires all 21 Recipe Agent calls concurrently (OQ7), then resolves variety collisions locally in a fixed slot order once all 21 ranked candidate lists return — each slot claims its top unclaimed candidate, stepping down to its own next-ranked candidate on collision (no extra API call); re-queries only if a slot's whole list is exhausted
- **AI composition/edit fallback:** for a slot where cascade fallback is exhausted (±30% with nothing acceptable) or pantry ingredients are being ignored, proposes a recipe — new or edited from a returned candidate — built around pantry ingredients and the macro target. This is judgment work Claude is well-suited to; the resulting macro numbers are not. Every ingredient in the proposal is resolved through the Recipe Agent's ingredient-level lookup and summed deterministically — the Orchestrator never accepts an LLM-estimated macro number for the dashboard. See Agent 2.
- **Snack/add-on selection:** when a meal or the weekly total is short of its macro target, can attach one small single-ingredient add-on (fruit, nuts, yogurt, protein powder) to a meal rather than distorting a full recipe's proportions — capped at ≤15–20% of that meal's calories and one add-on per slot. Tried before further cascade widening or a slack-meal requery.
- Runs a weekly reconciliation pass after all 21 meals are selected: sums actual macros, compares against a ±5% weekly band (tighter than the per-meal ±10-30% cascade); prefers closing the gap with a snack/add-on first, and only re-queries up to 3 slack meals if the gap is too large for that — capped at 3 extra queries per plan to protect API quota
- Deduplicates and aggregates ingredients across all 35 meal/snack slots (7 days × breakfast/lunch/dinner/snack1/snack2) into a single grocery list — keyed on Spoonacular's canonical ingredient `id` (not raw ingredient text) and unit-reconciled via the `measures.metric` data already returned by the Recipe Agent, so quantities are summed locally with no extra API call. **Each slot's ingredient amounts are scaled to reflect only the portion actually planned for that one meal** (the same per-slot macro-fit factor applied to macros, divided by the recipe's native serving count) — fixed July 2026 after live data showed ingredients weren't being scaled at all, which was the dominant cause of an inflated grocery total.
- Instructs the Price Agent to look up costs for each ingredient (see Agent 3 — Spoonacular primary, Tavily fallback)
- Excludes pantry items from the grocery list entirely, or — when a pantry entry has a comparable structured quantity (amount + unit) — reduces the needed amount by what's already on hand instead (see Agent 4)
- Generates the daily and weekly nutrition summary
- Runs as a persistent conversational session (F11): handles free-text requests to edit pantry, swap a meal, or change a constraint by calling the same underlying actions listed above — chat is a second interface onto these actions, not a separate mutation path
- **New (built July 15 2026): post-generation plan critique.** After reconciliation and the AI composition fallback both finish, makes one more Claude call — this time reviewing the entire generated week at once, not one meal at a time. Every other step above resolves one slot (or a handful of slack slots) in isolation; this is the only point in the flow where anything actually looks at all 35 slots together, which is what makes it possible to notice a recipe repeating 4 times or one meal being a much worse fit than the rest of the week even though it individually passed. The critique itself is judgment only — a list of flagged slots and why — never a replacement or a "this is better" verdict. See Agent 2's note below for what happens to a flagged slot.

**When it runs:** Persistent across the session (Steps 2–6 of the PRD flow) — not just a one-shot trigger. Full plan generation still fires on "Generate my meal plan"; individual actions (pantry edit, meal swap, constraint change) fire whenever the user does them via UI or chat.

**AI model:** Claude, Sonnet tier (default to the latest available Sonnet-tier model at build time — don't hardcode a specific version number in engineering; confirm current model when implementation starts). Upgrade path to Opus tier if constraint-satisfaction complexity grows at scale.

**Why AI and not a rule-based system:** The actual macro/budget matching is deterministic — see the cascade fallback, candidate ranking, budget fallback, and weekly reconciliation logic above and in the table below, none of which require an LLM to do combinatorial search or arithmetic. Claude's real value is narrower and falls into four buckets: (1) deciding what per-meal targets and params to request from each agent, (2) turning ambiguous or blocked outcomes (no match, budget miss, reconciliation still off-target) into clear, specific user-facing guidance, (3) the judgment calls in the AI composition/edit fallback and snack selection above — deciding *what* recipe or add-on makes sense given pantry and macro constraints, and (4) the post-generation plan critique — a holistic pattern-spotting task across all 35 slots that no per-slot deterministic step can do, since none of them ever see the whole week at once. In all four, the actual macro arithmetic and every accept/reject decision stays deterministic, resolved from Spoonacular's data and real comparison scores, never from Claude's own judgment about numbers.

---

## Agent 2 — Recipe Agent (Spoonacular MCP)

**Role:** Surfaces recipes that satisfy the user's macro and dietary constraints in a single API call.

**What it does:**
- Receives from Orchestrator: target protein/carb/fat/calorie ranges, dietary flags (vegetarian, gluten-free, etc.), excluded allergens, excluded recipe IDs (previously rated low or recently shown), and pantry ingredients (if entered — passed as `includeIngredients`, a soft preference that biases ranking, never a hard filter)
- Queries Spoonacular `/recipes/complexSearch` with `minProtein`, `maxProtein`, `minCalories`, `maxCalories`, `diet`, `excludeIngredients`, `excludeIds`, `includeIngredients`, plus `addRecipeInformation=true` and `fillIngredients=true` so `extendedIngredients` comes back with a full `measures` object (`us`/`metric` amount + unit) in the same call — this feeds both OQ4's serving-scaling and F4's cross-recipe dedup/unit-conversion, no second call needed. These two flags each cost 0.025 points per recipe returned (live-confirmed against a real key, July 2026 — see PRD OQ6). **Candidate count, corrected to match what shipped:** the original plan (3–5 candidates for a unique tuple, 7–8 for a shared meal-type tuple, implying 3 distinct queries/plan) assumed each meal type had its own target — the real per-meal target is identical across breakfast/lunch/dinner (daily ÷ 3), so all 21 slots share one constraint tuple and the shipped code fetches **one shared query at `number=60`** for the whole plan, not three separate ones. This is cheaper than the original plan, and PRD OQ6 has the resulting recomputed real capacity ceiling.
- When the query returns multiple candidates at the current tolerance tier, ranks them deterministically: score = `|protein_actual − protein_target| / protein_target × 2 + |calories_actual − calories_target| / calories_target` (lowest wins), with a small deduction for pantry-ingredient overlap; budget-compliant candidates ranked first (Pro only), with the cheapest macro-matching candidate appended as the fallback-of-last-resort only if none are budget-compliant. Ties broken by price (Pro only) → `aggregateLikes`. No LLM judgment in this step. Note: the "not used elsewhere this week" variety signal cannot apply during this initial per-slot ranking, since all 21 slots resolve concurrently (OQ7) — real variety enforcement happens in the Orchestrator's cross-slot claim-resolution pass afterward, not here.
- Returns: recipe name, ingredient list with quantities, per-serving nutrition data
- If zero results: widens tolerance range and retries (cascade fallback, up to 3 rounds); if a Pro budget constraint is still unmet after the macro cascade, drops budget filtering for that meal and selects the cheapest macro-matching result instead
- **If cascade fallback still returns nothing acceptable, or every candidate ignores pantry ingredients the user entered:** the Orchestrator triggers the AI composition/edit fallback instead of failing the slot. Claude proposes a recipe (new, or an edit to a returned candidate) using pantry ingredients and the macro target as inputs. Every ingredient in that proposal is then resolved via Spoonacular's ingredient-level endpoints — `/food/ingredients/search` to get a canonical ingredient `id`, `/food/ingredients/{id}/information` for its nutrition per unit — and macros are summed deterministically from that data. Claude decides the recipe/edit; it never supplies the macro number itself. If an ingredient can't be resolved this way, it's swapped for one that can be, or the fallback is abandoned and the slot falls through to OQ2's final "blocking constraint" prompt.
  - **Implemented July 15 2026 (`aiMealComposition.ts`/`mealProposer.ts`), NOT yet live-verified end-to-end:** a portion-realism check was added after the first real attempt asked for tofu to hit a demanding protein target and got told to use 346g of it — an amount that also, on its own, already blew past the meal's fat target. The fix has two parts: Claude is now explicitly told to pick a protein source dense enough for the target within a normal portion (not just diet-compliant), and a deterministic bound rejects the whole composition outright if any ingredient's solved amount still falls outside a realistic serving range, regardless of how good the proposed ingredient was. Safety for these proposals uses a separate, stricter check than the fixed pantry/snack pool below — an ingredient Claude names that this system doesn't recognize defaults to *unsafe*. Gated behind `ANTHROPIC_API_KEY`, currently unconfigured — deferred by explicit decision, not blocking.
- **Snack/add-on resolution:** the same ingredient-level endpoints resolve single-ingredient add-ons (fruit, nuts, yogurt, protein powder) the Orchestrator attaches to a meal to close a macro gap — capped at one per slot, ≤15–20% of that meal's calories. Same grounding rule: Claude picks the item, Spoonacular's ingredient data supplies the macros.
  - **Real gap found and fixed July 15 2026:** confirmed this fixed 9-ingredient pool (used by both the snack composer and the add-on selector) had never checked a profile's allergies, dietary style, or dislikes at all — a nut allergy could get served almonds. Now fail-closed against the same exclusion words used for Spoonacular's `excludeIngredients`, live-verified against a real nut-allergy generation with zero violations. The same pool also had no pantry- or price-awareness, unlike the Recipe Agent's own soft-preference/budget mechanisms above — fixed the same day: a pantry match wins outright; failing that, the cheaper *half* (not just the single cheapest) of a role's options are preferred when budget-aware, since the real cost gaps between fixed-pool ingredients (43-570%) meant "prefer only the cheapest" collapsed a live-tested plan's snack variety to the same combo 14/14 times.
- **Post-generation plan critique repair:** when the Orchestrator's plan critique (Agent 1) flags a slot as repetitive or a poor macro fit, this agent is asked for one real alternative the same way a user-triggered "Swap meal" would — same cascade, same constraints. The Orchestrator compares the alternative's macro-deviation score against the original's and only keeps the swap if it's a genuine, measured improvement (and, for a repetition flag, if it doesn't introduce a different duplicate). This agent has no say in that decision — it just returns a real candidate or reports none found, same as any other query.
- If Spoonacular is unreachable or the daily quota is exhausted: returns the cached last-successful plan for that user instead of erroring — Orchestrator surfaces a "using last week's plan" banner
- Two distinct server-side caches, not one:
  1. **Query-result cache (cross-user):** keyed on the constraint tuple (`minProtein`/`maxProtein`/`minCalories`/`maxCalories`/`diet`/`excludeIngredients`) — deliberately excludes `excludeIds`, since that's per-user (recent/low-rated recipes) and would fragment the cache to near-zero hit rate if included. This is the cache that actually reduces API point consumption across users with similar targets.
  2. **Last-successful-plan cache (per-user):** keyed on user ID, stores that user's full most recent plan. Used only as the outage/quota-exhaustion fallback described above — not a point-saving mechanism.

**Data returned to Orchestrator:** Recipe name, `servings` count, `extendedIngredients` (`id`, name, amount, unit, and a `measures` object with `us`/`metric` amount + unit), per-serving macros (protein, carbs, fat, calories)

**API:** Spoonacular paid tier ($29/month, 1,500 points/day)

**Scale-up path:** Originally scoped as development/early-cohort-only, not sized for KR1's full subscriber target — a July 2026 recompute (PRD OQ6), grounded in the real shipped code (one shared query per plan, not three) plus live-confirmed point costs, now puts the ceiling at ~134-268 plans/day, above what KR1/KR2 require. Not yet production-confirmed. Trigger: move to a higher Spoonacular tier or Edamam once measured daily generation volume reaches ~75% of the (now much higher) OQ6-confirmed ceiling — monitored proactively, not reactively. **Separate quota bug found and fixed July 15 2026:** the fixed 9-ingredient snack/add-on pool was being re-fetched live from these same ingredient endpoints on every single generation, uncached — live-confirmed to burn ~46.5 of a fresh 50-point key on one hard-profile generation, before failing outright. These 9 names never change per-user, so there was no reason to query them live at all; pinning their real macro and cost data in a static table dropped that same generation's cost to ~1 point. This was a pure implementation bug in the snack/add-on path, not a flaw in the recompute above, which covers recipe-search cost only and still holds.

---

## Agent 3 — Price Agent (Spoonacular primary, Tavily fallback)

**Role:** Estimates the current grocery price for each ingredient on the weekly grocery list (F4).

**Architecture change (built + live-tested July 2026, replacing the original Tavily-first design below):** Tavily's `include_answer` (an LLM-synthesized sentence, regex-parsed for a dollar figure) turned out unreliable as a primary source — live testing found it can grab the wrong price out of a multi-price answer (e.g. a whole-item headline price instead of the per-unit figure actually asked for), which was traced back as the dominant cause of a wildly inflated real grocery total. Spoonacular's own `/food/ingredients/{id}/information` endpoint returns a **structured** `estimatedCost` field — a real number, not text to parse — and was live-validated as accurate across weight, volume, and count-based ingredients (including messy real units like "large head," "clove," "servings," even a garbled "2-inch"). Tavily is now a fallback only, used when Spoonacular genuinely has no cost data for an ingredient.

**What it does:**
- Receives from Orchestrator: the ingredient's Spoonacular `id` (already known — every grocery line traces back to the recipe/composition data that produced it, so no separate search call is needed) and the exact quantity/unit needed
- **Primary:** calls Spoonacular's ingredient information endpoint with that exact amount/unit and reads `estimatedCost` directly — no region parameter (Spoonacular's cost data isn't region-specific)
- **Fallback only:** if Spoonacular has no cost data, queries Tavily Search API (`include_answer: true`, phrased to ask for a price per the same reference quantity, using the user's US region from zip code) and extracts a dollar figure via regex from Tavily's own synthesized answer — no separate Haiku-tier extraction call
- Before either lookup: checks a stored 30-day rate cache, keyed by (user, ingredient, region, unit-basis: per-100g / per-100ml / per-unit-count) — reused if fresh, re-queried only if stale or absent. The cache stores a *rate*, not a flat total, so it correctly reapplies even when the ingredient's needed quantity differs the following week
- Returns: estimated price for the exact quantity requested
- If neither source has data: returns `null` — Orchestrator displays "$—" with "add manually" prompt
- Any manual correction the user makes in F4 is written back into the same 30-day rate cache, keyed the same way, for reuse in future weeks

**Data returned to Orchestrator:** Price estimate (USD) for the requested quantity

**API:** Spoonacular (already the core paid dependency — no new vendor, though a new per-ingredient cost load not yet measured against the existing capacity ceiling, see PRD OQ9), Tavily Search API (1,000 free credits/month) as fallback only

**Limitation:** Both sources return estimates, not guaranteed real-time local retail data. Manual override always available. **Known gap (PRD OQ9):** this price is never reconciled against the recipe-level budget check the Orchestrator performs during generation (Agent 1/Agent 2's `pricePerServingCents`) — the two are independently-sourced numbers describing the same ingredients and can diverge; not yet tested across multiple real budgeted profiles.

**Scale-up path:** Kroger Developer API for real-time shelf prices once the combined Spoonacular/Tavily estimate accuracy drops below threshold

---

## Agent 4 — Pantry Agent (Custom MCP)

**Role:** The personalisation layer. Owns all user-specific persistent state: pantry inventory, dietary constraints, allergen flags, dislikes, weekly budget, and meal ratings.

**MVP scope note (updated):** dietary constraints, allergen flags, dislikes, weekly budget, and pantry inventory are all active from day one (F2, F6) — the Orchestrator reads pantry contents *before* querying the Recipe Agent, not just to exclude items from the grocery list afterward. Only two pieces remain V2: barcode-scanned pantry entry (F8 — manual entry ships in MVP) and meal ratings (F7); see PRD F3/F6.

**What it does:**
- Stores and retrieves: pantry items (name, expiry date, a free-text rough-quantity note, and — **built July 2026** — an optional structured quantity: a numeric amount + unit, e.g. "2, lb"), dietary restrictions, allergy flags, disliked ingredients, weekly grocery budget, meal rating history (thumbs up/down by recipe ID)
- Provides Orchestrator with: current pantry contents (used to bias Recipe Agent queries *and* to exclude/reduce the grocery list), low-rated recipe IDs (to add to `excludeIds`, V2), user's allergen list, budget ceiling
- **When a pantry item's structured amount/unit is comparable to a grocery line's** (same weight/volume unit category, or the same "other" count descriptor, e.g. "clove" vs. "cloves") — the needed amount is reduced by what's on hand, converting units deterministically (no LLM — the same reasoning that kept Agent 3's price math off an LLM applies here: arithmetic, not judgment). **Falls back to the original all-or-nothing exclusion** whenever a match has no structured quantity or an incompatible unit — never a regression for pantry entries that only ever used the free-text note.
- Accepts chat-driven edits from the Orchestrator's conversational session (F11) — same storage, no separate write path
- Updates after each shop: marks pantry items as added from grocery list
- Expires pantry items after 7 days unless refreshed (V2 — manual pantry entry itself is MVP, this automation is not)

**Data returned to Orchestrator:** Pantry contents (name + quantity), allergen list, disliked ingredients, budget, excluded recipe IDs from low ratings

**Implementation:** Custom-authored MCP server. Stored locally in MVP (user's browser/account). Cloud-synced in V2.

---

## Agent 5 — Barcode Agent (Open Food Facts MCP) — V2

**Role:** Resolves a product barcode into a pantry-ready item entry without manual typing.

**What it does:**
- Triggered when user opens the barcode scanner in the Pantry screen
- Captures barcode via browser camera (ZXing-js)
- Queries Open Food Facts API: `GET /api/v3/product/{barcode}.json`
- Extracts: product name, serving size, macro data (if available)
- Returns pre-filled item to the Pantry Agent for confirmation and storage
- Fallback: if product not found in Open Food Facts, prompts manual entry

**Data returned to Pantry Agent:** Product name, quantity estimate, macro data (passed through for nutritional reference)

**API:** Open Food Facts (free, no API key, User-Agent header only)

---

## Agent 6 — Calendar Export Agent (No API)

**Role:** Converts the weekly meal plan into a downloadable `.ics` calendar file.

**What it does:**
- Triggered when user taps "Export to Calendar"
- Receives meal plan from Orchestrator: 21 meals × (name, meal type, time slot, macro summary)
- Uses the `ics` npm package to generate one calendar event per meal: event title = meal name, description = macro summary, time = meal type (breakfast 8am / lunch 12pm / dinner 7pm)
- Outputs a downloadable `.ics` file compatible with Google Calendar, Apple Calendar, Outlook

**API:** None — runs entirely client-side

---

## How the Agents Work Together — Full Flow

```
1. User completes onboarding (F1, F2) and, optionally, pantry entry (F6, moved up from V2)
   └── Pantry Agent stores constraints: goal, macros, allergies, preferences, budget
   └── Pantry *inventory* can now be populated here too (Step 2 of the PRD flow, or later
         via the conversational assistant, F11) — no longer gated to V2

2. User taps "Generate meal plan"
   └── Orchestrator reads Pantry Agent's stored constraints and any pantry inventory
   └── Orchestrator calls Recipe Agent × 21 (3 meals × 7 days), all 21 concurrently (OQ7)
       ├── Each slot independently: queries Spoonacular with macro + dietary constraints,
       │     plus pantry ingredients as a soft `includeIngredients` preference if entered
       ├── If no macro match → cascade tolerance widening (up to 3 rounds, ±10%→±20%→±30%)
       ├── If Pro budget still unmet after macro cascade → drop budget filter for that meal,
       │     select cheapest macro-matching option, label with budget delta
       ├── If cascade fallback is exhausted, or every candidate ignores entered pantry
       │     ingredients → AI composition/edit fallback: Claude proposes a recipe or edit,
       │     every ingredient grounded via Spoonacular's ingredient endpoint (see Agent 2)
       ├── If Spoonacular is unavailable/quota-exhausted → serve cached last-successful
       │     plan with a banner instead of failing
       ├── Ranks its own candidates at the matched tier by weighted deviation from the
       │     per-meal target (with a small pantry-overlap deduction), budget-compliant
       │     candidates ranked first and the cheapest macro-match appended as fallback
       │     only if none are budget-compliant (deterministic score, not AI-judged — see
       │     Agent 2)
       └── Each slot returns its own ranked candidate list, not yet a single final pick

       Once all 21 lists are back (OQ7 collision resolution):
       ├── Orchestrator resolves variety collisions in a fixed slot order (Day 1
       │     Breakfast → Day 7 Dinner): each slot greedily claims its top unclaimed
       │     candidate from its own list; a slot whose top pick is already claimed
       │     steps down to its own next-ranked candidate — no extra Spoonacular call
       ├── Only if a slot's whole candidate list is exhausted does it re-query (rare,
       │     capped like the reconciliation pass below)
       └── Returns 21 recipes with per-serving nutrition data

3. Orchestrator runs weekly reconciliation
   └── Sums actual macros across all 21 meals, compares to weekly target (±5% band —
         tighter than the ±10-30% per-meal cascade)
   └── If outside band → first tries attaching a snack/add-on (single-ingredient, capped
         at ≤15-20% of that meal's calories, one per slot) to the meal(s) furthest from
         target, grounded via Spoonacular's ingredient endpoint (see Agent 2)
   └── If the gap is still too large for a snack to close → re-queries up to 3 slack meals
         (furthest from their own per-meal target, in the direction that closes the gap)
   └── Capped at 3 extra queries per plan to protect API quota
   └── If still outside ±5% after the cap → weekly dashboard (F5) shows the real
         delta instead of implying an exact match

3a. Orchestrator runs the post-generation plan critique (new, gated behind an API key)
    └── One Claude call reviews all 35 claimed slots at once, flags any that look
          repetitive or macro-off, with a reason for each
    └── For each flagged slot: Recipe Agent is asked for one real alternative (same
          cascade, same constraints, excluding every recipe already used in the plan)
    └── Orchestrator compares the alternative's macro-deviation score to the
          original's, deterministically — only replaces the slot if the alternative
          is a real improvement, and for a repetition flag, only if it doesn't
          introduce a different duplicate
    └── Skipped entirely if no API key is configured, or if the critique call fails —
          the plan from steps 2-3 stands as generated either way

4. Orchestrator aggregates grocery list
   └── Scales ingredient quantities: (amount ÷ servings) × frequency
         — live-confirmed correctly implemented July 2026 (previously ingredients
           weren't scaled at all, inflating a real weekly total 7-8x)
   └── Deduplicates across all 35 meal/snack slots (7 days × 5 slot types)
   └── Removes, or quantitatively reduces, any items already in Pantry Agent
         inventory depending on whether a comparable structured quantity was
         given — now MVP, not V2-gated (see PRD F3/F6)
   └── Calls Price Agent for each grocery item
       ├── Checks the 30-day rate cache first (reused across weeks, keyed by
       │     ingredient + region + unit-basis, not a flat per-line price)
       ├── If none stored → Price Agent queries Spoonacular's ingredient cost
       │     endpoint first (structured, primary)
       └── Only if Spoonacular has no data → falls back to Tavily → returns
             estimate or null

5. Orchestrator renders outputs
   ├── Meal plan (F3): 7-day view with per-meal macros
   ├── Grocery list (F4): deduped items with prices
   └── Nutrition dashboard (F5): daily/weekly vs. targets

6. User taps "↺ Swap meal" — or asks the conversational assistant (F11) to do the same
   └── Orchestrator calls Recipe Agent for one slot
       ├── Excludes the rejected recipe ID
       ├── Applies the same cascade fallback as initial generation, then the AI
       │     composition/edit fallback if cascade is exhausted
       ├── If both fallbacks fail → shows the blocking-constraint prompt scoped to that
       │     slot, never a dead end
       ├── Returns a new recipe for that slot only
       └── Updates grocery list and nutrition totals

6a. At any point in Steps 2–6, user chats with the conversational assistant (F11)
    └── Free-text request (edit pantry, swap a meal, change a constraint) is parsed and
          mapped to the same action the corresponding UI control would trigger — no
          separate mutation path
    └── Ambiguous requests, or ones that would violate a hard constraint (e.g. an allergen),
          get an explanation instead of being executed

7. User logs an off-plan meal (F5)
   └── Free-text or ingredient-search entry, macro-estimated and added to daily/weekly
         totals — keeps the dashboard accurate when the user deviates from the plan

8. User taps "Export to Calendar"
   └── Calendar Export Agent generates .ics file → downloads

9. Week 2+ (loop)
   └── Orchestrator pre-fills same goal from Pantry Agent
   └── Low-rated recipes (F7, V2) added to excludeIds
   └── New plan generated with fresh Spoonacular query
```

---

## AI vs. Rule-Based: Why This Needs AI

| Decision | Rule-based? | Why AI wins |
|---|---|---|
| Match 21 recipes to macro targets | Partial (filter) | Per-meal filtering, cascade widening, candidate ranking, budget fallback, and weekly reconciliation are all deterministic (see rows below) — Claude's actual role is deciding what per-meal targets/params to request and translating blocked states into clear user guidance, not solving a combinatorial search itself |
| Cascade tolerance fallback | Yes (logic) | Simple rules work here — implemented as structured retry logic, not AI |
| Candidate ranking within a tolerance tier | Yes (logic) | Weighted-deviation score, deterministic sort — no AI judgment |
| Weekly reconciliation after all 21 meals selected | Yes (logic) | Sum vs. target, re-query slack meals — deterministic, not AI |
| Ingredient deduplication | Yes (logic) | Keyed on Spoonacular's ingredient `id` + `measures.metric` unit conversion — deterministic aggregation once the right key is used, not raw name-string matching, no AI needed |
| Price lookup per ingredient | Yes (mostly) | **Updated July 2026:** Spoonacular's `estimatedCost` is a structured field — a deterministic lookup, no AI at all, and now the primary path. Only the rare Tavily fallback involves any text extraction, and even that leans on Tavily's *own* internal answer-synthesis (not a Claude call we make) — the extraction on our side is still a plain deterministic regex, not NLP we perform |
| Serving-size scaling | Yes (formula) | `(amount ÷ servings) × frequency` — deterministic |
| Grocery list generation | Yes (aggregation) | Deterministic once recipes are selected |
| AI composition/edit fallback (when cascade fails or pantry is ignored) | Partial | Deciding what recipe/edit to propose given pantry + macro constraints is a judgment call AI is good at; the resulting macros are never AI-estimated — every ingredient resolves to Spoonacular's ingredient endpoint and is summed deterministically, same as the dedup row above |
| Snack/add-on selection to close a macro gap | Partial | Same split as above: Claude picks which single-ingredient item makes sense, the calorie-share cap and macro math are deterministic |
| Chat-driven pantry/meal/constraint edits (F11) | No | Free-text intent parsing needs an LLM; the resulting mutation is the same deterministic action the UI already performs — no new write path |
| Post-generation plan critique (which slots to reconsider) | No | Spotting a repeated recipe or an outlier macro fit across 35 slots at once is a holistic pattern-match no per-slot deterministic step can perform — nothing else in this flow ever sees the whole week simultaneously |
| Accepting or rejecting a critique-flagged repair | Yes (logic) | Real macro-deviation score comparison plus a duplicate-title check, both deterministic — the critic flags candidates for a second look, it never decides which result is better |

**Bottom line:** AI is used where human-like reasoning across multiple constraints — or free-text intent — is required (recipe selection and composition, price extraction, chat understanding). The moment a macro number is involved, it's computed deterministically from Spoonacular's data, never estimated by the LLM. Deterministic logic handles everything else.

---

*MacroMap · AI Agents v1 · July 2026*
