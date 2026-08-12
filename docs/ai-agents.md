# MacroMap — AI Agents

> How will your product use AI?

**Stage:** Pre-seed | **Date:** July 2026

---

## Overview

MacroMap is built as an **AI agent system** — a central orchestrator (Claude) coordinates a set of specialised MCP (Model Context Protocol) agents, each owning one data domain. The orchestrator reasons across all agents simultaneously to produce contextual recommendations that no single data source could generate alone.

**Architecture update (pantry-first, conversational, AI-composed recipes):** three changes to the original design, all folded into the sections below. (1) Pantry contents are now read *before* recipe queries fire, not just used to filter the grocery list afterward — this moves Pantry Agent data (previously V2-only) into the MVP critical path. (2) The Orchestrator is now a persistent, conversational session across the whole flow, not a one-shot trigger on "Generate" / "Swap" — the user can edit pantry, swap meals, or change constraints in plain language at any point. (3) When Spoonacular search can't produce an acceptable recipe (cascade exhausted, or pantry ingredients ignored), Claude can compose or edit a recipe, and can attach a small snack/add-on to a meal to close a macro gap — in both cases every macro number is still resolved from Spoonacular's ingredient-level nutrition data, never estimated by the LLM. See Agent 1, Agent 2, and Agent 3 below, and PRD F3/F5/F7.

**Fourth change, added July 15 2026: post-generation plan critique.** After a plan is fully generated, one more Claude call reviews the whole week at once and flags slots worth reconsidering — repetitive recipes, or a meal that's a notably worse macro fit than the rest of the week. Every flagged slot's actual fate is still decided deterministically (a real alternative, scored and compared, never just trusted). See Agent 1's new bullet and Agent 2's repair note below. **Update:** this and (3) above were gated behind `ANTHROPIC_API_KEY` while it was unconfigured — the key is now configured and both are live in production, actively being refined against real usage (see the August 2026 chat-editing bug-fix rounds referenced throughout this doc and hypotheses.md H6).

**Fifth change, built + live-tested July 2026: grocery list quantities corrected against real data.** A deterministic fix, no LLM involved: each grocery ingredient's quantity now correctly reflects *only* the portion actually planned for that meal — scaled by the same per-slot macro-fit factor Agent 2 already computes, divided by the recipe's native serving count (Spoonacular's ingredient amounts are for the whole recipe batch, not one serving). Pantry exclusion (Agent 3) also gained an optional quantitative mode alongside its original all-or-nothing behavior. See F4/F5 in the PRD and Agent 3 below.

```
User Goal Input
      │
      ▼
┌─────────────────────────────────────────────────────┐
│              Orchestrator Agent (Claude)             │
│  Holds the full context: goal + constraints +       │
│  pantry + preferences                                │
└──────┬──────────────────────┬──────────────────────┘
       │                      │
       ▼                      ▼
 Recipe Agent            Pantry Agent
 (Spoonacular)           (Custom MCP)
```

---

## Agent 1 — Orchestrator (Claude)

**Role:** The central reasoning layer. Receives the user's weekly goal and coordinates all downstream agents to produce the meal plan and grocery list.

**What it does:**
- Accepts user inputs: macro targets, dietary preferences, allergies, pantry contents
- Reads Pantry Agent contents *before* querying recipes (moved up from V2 — see Agent 3) and passes them to the Recipe Agent as a soft preference, biasing candidate selection toward on-hand ingredients without overriding any hard constraint
- Decides which recipes to query (what constraints to pass to the Recipe Agent)
- Applies the cascade tolerance fallback (±10% → ±20% → ±30%) when no recipe matches
- Fires all 21 Recipe Agent calls concurrently (OQ7), then resolves variety collisions locally in a fixed slot order once all 21 ranked candidate lists return — each slot claims its top unclaimed candidate, stepping down to its own next-ranked candidate on collision (no extra API call); re-queries only if a slot's whole list is exhausted
- **AI composition/edit fallback:** for a slot where cascade fallback is exhausted (±30% with nothing acceptable) or pantry ingredients are being ignored, proposes a recipe — new or edited from a returned candidate — built around pantry ingredients and the macro target. This is judgment work Claude is well-suited to; the resulting macro numbers are not. Every ingredient in the proposal is resolved through the Recipe Agent's ingredient-level lookup and summed deterministically — the Orchestrator never accepts an LLM-estimated macro number. See Agent 2.
- **Snack/add-on selection:** when a meal or the weekly total is short of its macro target, can attach one small single-ingredient add-on (fruit, nuts, yogurt, protein powder) to a meal rather than distorting a full recipe's proportions — capped at ≤15–20% of that meal's calories and one add-on per slot. Tried before further cascade widening or a slack-meal requery.
- Runs a weekly reconciliation pass after all 21 meals are selected: sums actual macros, compares against a ±5% weekly band (tighter than the per-meal ±10-30% cascade); prefers closing the gap with a snack/add-on first, and only re-queries up to 3 slack meals if the gap is too large for that — capped at 3 extra queries per plan to protect API quota
- Deduplicates and aggregates ingredients across all 35 meal/snack slots (7 days × breakfast/lunch/dinner/snack1/snack2) into a single grocery list — keyed on Spoonacular's canonical ingredient `id` (not raw ingredient text) and unit-reconciled via the `measures.metric` data already returned by the Recipe Agent, so quantities are summed locally with no extra API call. **Each slot's ingredient amounts are scaled to reflect only the portion actually planned for that one meal** (the same per-slot macro-fit factor applied to macros, divided by the recipe's native serving count) — fixed July 2026 after live data showed ingredients weren't being scaled at all, which was the dominant cause of an inflated grocery total.
- Excludes pantry items from the grocery list entirely, or — when a pantry entry has a comparable structured quantity (amount + unit) — reduces the needed amount by what's already on hand instead (see Agent 3)
- Runs as a persistent conversational session (F7): handles free-text requests to edit pantry, swap a meal, or change a constraint by calling the same underlying actions listed above — chat is a second interface onto these actions, not a separate mutation path
- **New (built July 15 2026): post-generation plan critique.** After reconciliation and the AI composition fallback both finish, makes one more Claude call — this time reviewing the entire generated week at once, not one meal at a time. Every other step above resolves one slot (or a handful of slack slots) in isolation; this is the only point in the flow where anything actually looks at all 35 slots together, which is what makes it possible to notice a recipe repeating 4 times or one meal being a much worse fit than the rest of the week even though it individually passed. The critique itself is judgment only — a list of flagged slots and why — never a replacement or a "this is better" verdict. See Agent 2's note below for what happens to a flagged slot.

**When it runs:** Persistent across the session (Steps 2–5 of the PRD flow) — not just a one-shot trigger. Full plan generation still fires on "Generate my meal plan"; individual actions (pantry edit, meal swap, constraint change) fire whenever the user does them via UI or chat.

**AI model:** Claude, Sonnet tier (default to the latest available Sonnet-tier model at build time — don't hardcode a specific version number in engineering; confirm current model when implementation starts). Upgrade path to Opus tier if constraint-satisfaction complexity grows at scale.

**Why AI and not a rule-based system:** The actual macro matching is deterministic — see the cascade fallback, candidate ranking, and weekly reconciliation logic above and in the table below, none of which require an LLM to do combinatorial search or arithmetic. Claude's real value is narrower and falls into four buckets: (1) deciding what per-meal targets and params to request from each agent, (2) turning ambiguous or blocked outcomes (no match, reconciliation still off-target) into clear, specific user-facing guidance, (3) the judgment calls in the AI composition/edit fallback and snack selection above — deciding *what* recipe or add-on makes sense given pantry and macro constraints, and (4) the post-generation plan critique — a holistic pattern-spotting task across all 35 slots that no per-slot deterministic step can do, since none of them ever see the whole week at once. In all four, the actual macro arithmetic and every accept/reject decision stays deterministic, resolved from Spoonacular's data and real comparison scores, never from Claude's own judgment about numbers.

---

## Agent 2 — Recipe Agent (Spoonacular MCP)

**Role:** Surfaces recipes that satisfy the user's macro and dietary constraints in a single API call.

**What it does:**
- Receives from Orchestrator: target protein/carb/fat/calorie ranges, dietary flags (vegetarian, gluten-free, etc.), excluded allergens, excluded recipe IDs (recently shown), and pantry ingredients (if entered — passed as `includeIngredients`, a soft preference that biases ranking, never a hard filter)
- Queries Spoonacular `/recipes/complexSearch` with `minProtein`, `maxProtein`, `minCalories`, `maxCalories`, `diet`, `excludeIngredients`, `excludeIds`, `includeIngredients`, plus `addRecipeInformation=true` and `fillIngredients=true` so `extendedIngredients` comes back with a full `measures` object (`us`/`metric` amount + unit) in the same call — this feeds both OQ4's serving-scaling and F4's cross-recipe dedup/unit-conversion, no second call needed. These two flags each cost 0.025 points per recipe returned (live-confirmed against a real key, July 2026 — see PRD OQ6). **Candidate count, corrected to match what shipped:** the original plan (3–5 candidates for a unique tuple, 7–8 for a shared meal-type tuple, implying 3 distinct queries/plan) assumed each meal type had its own target — the real per-meal target is identical across breakfast/lunch/dinner (daily ÷ 3), so all 21 slots share one constraint tuple and the shipped code fetches **one shared query at `number=60`** for the whole plan, not three separate ones. This is cheaper than the original plan, and PRD OQ6 has the resulting recomputed real capacity ceiling.
- When the query returns multiple candidates at the current tolerance tier, ranks them deterministically: score = `|protein_actual − protein_target| / protein_target × 2 + |calories_actual − calories_target| / calories_target` (lowest wins), with a deduction for pantry-ingredient overlap. Ties broken by `aggregateLikes`. No LLM judgment in this step. Note: the "not used elsewhere this week" variety signal cannot apply during this initial per-slot ranking, since all 21 slots resolve concurrently (OQ7) — real variety enforcement happens in the Orchestrator's cross-slot claim-resolution pass afterward, not here.
- **Pantry-overlap deduction is now quantity-aware, not static (built July 25 2026, `pantryRemaining.ts`):** a live "remaining quantity" tracker depletes as slots get claimed during generation, so a recipe's pantry credit shrinks as other slots use up the same on-hand stock, instead of every slot seeing an identical boolean bonus regardless of what's already spoken for. **Known, accepted limitation:** the very first parallel-scored ranking of all 21 slots reads from one shared snapshot before anything is claimed, so it can't yet reflect same-pass depletion — only slots re-scored afterward (retries, reconciliation, protein-floor repair, plan-critique repair, and the standalone swap action) see genuine, shrinking pantry credit. See Agent 3 for the matching/conversion mechanics this tracker relies on.
- Returns: recipe name, ingredient list with quantities, per-serving nutrition data
- If zero results: widens tolerance range and retries (cascade fallback, up to 3 rounds)
- **If cascade fallback still returns nothing acceptable, or every candidate ignores pantry ingredients the user entered:** the Orchestrator triggers the AI composition/edit fallback instead of failing the slot. Claude proposes a recipe (new, or an edit to a returned candidate) using pantry ingredients and the macro target as inputs. Every ingredient in that proposal is then resolved via Spoonacular's ingredient-level endpoints — `/food/ingredients/search` to get a canonical ingredient `id`, `/food/ingredients/{id}/information` for its nutrition per unit — and macros are summed deterministically from that data. Claude decides the recipe/edit; it never supplies the macro number itself. If an ingredient can't be resolved this way, it's swapped for one that can be, or the fallback is abandoned and the slot falls through to OQ2's final "blocking constraint" prompt.
  - **Implemented July 15 2026 (`aiMealComposition.ts`/`mealProposer.ts`), now live:** a portion-realism check was added after the first real attempt asked for tofu to hit a demanding protein target and got told to use 346g of it — an amount that also, on its own, already blew past the meal's fat target. The fix has two parts: Claude is now explicitly told to pick a protein source dense enough for the target within a normal portion (not just diet-compliant), and a deterministic bound rejects the whole composition outright if any ingredient's solved amount still falls outside a realistic serving range, regardless of how good the proposed ingredient was. Safety for these proposals uses a separate, stricter check than the fixed pantry/snack pool below — an ingredient Claude names that this system doesn't recognize defaults to *unsafe*. `ANTHROPIC_API_KEY` is now configured; this path runs against the real API in production, alongside the chat assistant and plan critique below.
- **Snack/add-on resolution:** the same ingredient-level endpoints resolve single-ingredient add-ons (fruit, nuts, yogurt, protein powder) the Orchestrator attaches to a meal to close a macro gap — capped at one per slot, ≤15–20% of that meal's calories. Same grounding rule: Claude picks the item, Spoonacular's ingredient data supplies the macros.
  - **Real gap found and fixed July 15 2026:** confirmed this fixed 9-ingredient pool (used by both the snack composer and the add-on selector) had never checked a profile's allergies, dietary style, or dislikes at all — a nut allergy could get served almonds. Now fail-closed against the same exclusion words used for Spoonacular's `excludeIngredients`, live-verified against a real nut-allergy generation with zero violations. The same pool also had no pantry-awareness, unlike the Recipe Agent's own soft-preference mechanism above — fixed the same day: a pantry match wins outright when one of a role's safe options is already on hand.
- **Post-generation plan critique repair:** when the Orchestrator's plan critique (Agent 1) flags a slot as repetitive or a poor macro fit, this agent is asked for one real alternative the same way a user-triggered "Swap meal" would — same cascade, same constraints. The Orchestrator compares the alternative's macro-deviation score against the original's and only keeps the swap if it's a genuine, measured improvement (and, for a repetition flag, if it doesn't introduce a different duplicate). This agent has no say in that decision — it just returns a real candidate or reports none found, same as any other query.
- If Spoonacular is unreachable or the daily quota is exhausted: returns the cached last-successful plan for that user instead of erroring — Orchestrator surfaces a "using last week's plan" banner
- Two distinct server-side caches, not one:
  1. **Query-result cache (cross-user):** keyed on the constraint tuple (`minProtein`/`maxProtein`/`minCalories`/`maxCalories`/`diet`/`excludeIngredients`) — deliberately excludes `excludeIds`, since that's per-user (recently-shown recipes) and would fragment the cache to near-zero hit rate if included. This is the cache that actually reduces API point consumption across users with similar targets.
  2. **Last-successful-plan cache (per-user):** keyed on user ID, stores that user's full most recent plan. Used only as the outage/quota-exhaustion fallback described above — not a point-saving mechanism.

**Data returned to Orchestrator:** Recipe name, `servings` count, `extendedIngredients` (`id`, name, amount, unit, and a `measures` object with `us`/`metric` amount + unit), per-serving macros (protein, carbs, fat, calories)

**API:** Spoonacular paid tier ($29/month, 1,500 points/day)

**Scale-up path:** Originally scoped as development/early-cohort-only, not sized for KR1's full subscriber target. A July 2026 code-grounded recompute (PRD OQ6) briefly suggested a much higher ceiling (~134-268 plans/day) — since superseded by a real 15-profile live batch that measured actual cost averaging **~34.2 pts/generation**, putting real capacity at **~44 plans/day, roughly half the ~600/week KR2 needs.** Edamam ($38/month) is the validated fallback vendor. Trigger: move to a higher Spoonacular tier or Edamam once measured daily generation volume reaches ~75% of this corrected ceiling — monitored proactively, not reactively. **Separate quota bug found and fixed July 15 2026:** the fixed 9-ingredient snack/add-on pool was being re-fetched live from these same ingredient endpoints on every single generation, uncached — live-confirmed to burn ~46.5 of a fresh 50-point key on one hard-profile generation, before failing outright. These 9 names never change per-user, so there was no reason to query them live at all; pinning their real macro data in a static table dropped that same generation's cost to ~1 point. This was a pure implementation bug in the snack/add-on path, not a flaw in the recompute above, which covers recipe-search cost only and still holds.

---

## Agent 3 — Pantry Agent (Custom MCP)

**Role:** The personalisation layer. Owns all user-specific persistent state: pantry inventory, dietary constraints, allergen flags, and dislikes.

**MVP scope note (updated):** dietary constraints, allergen flags, dislikes, and pantry inventory are all active from day one (F2, F5) — the Orchestrator reads pantry contents *before* querying the Recipe Agent, not just to exclude items from the grocery list afterward; see PRD F3/F5.

**What it does:**
- Stores and retrieves: pantry items (name, expiry date, a free-text rough-quantity note, and — **built July 2026** — an optional structured quantity: a numeric amount + unit, e.g. "2, lb"), dietary restrictions, allergy flags, disliked ingredients
- Provides Orchestrator with: current pantry contents (used to bias Recipe Agent queries, to feed the quantity-aware ranking tracker described in Agent 2, *and* to exclude/reduce the grocery list), user's allergen list
- **Matching a pantry item to a grocery-list line or recipe ingredient is now an LLM identity classifier, not string/unit comparison (rebuilt July 2026, `identityMatch.ts`):** a Claude Haiku-tier forced-tool-call judges whether the two names refer to the *same purchasable item* (e.g. "jasmine rice" vs. "white rice" — yes; "green onions" vs. "onion" — no), because one real ingredient routinely resolves to several different Spoonacular ids across a plan's recipes, which made id-based or plain-substring matching unreliable. Judgments are cached **globally**, not per-user, since ingredient identity doesn't depend on who's asking — cost amortizes toward zero as the common vocabulary gets seen once.
- **Once matched, the needed amount is reduced by what's on hand** using a pool that's drawn down across every matching line (not reapplied redundantly per line — a real double-counting bug found and fixed). Same-unit-category conversion is deterministic arithmetic, same as before; **cross-category conversion (e.g. a pantry entry in ml offsetting a recipe line in grams) is now resolved via a real Spoonacular density-conversion API call** (`unitConversion.ts`, `/recipes/convert`, live-confirmed density-accurate — 500ml olive oil → 456.5g, matching real olive-oil density), not an LLM guess and not a same-category-only restriction. Also cached globally. **Falls back to the original all-or-nothing exclusion** only when *no* matching pantry item has a usable/convertible quantity — never a regression for pantry entries that only ever used the free-text note.
- **Feeds meal ranking's live depletion tracker too, not just the grocery list (built July 25 2026, `pantryRemaining.ts`):** the same matching logic (in an unresolved, no-LLM form for latency-sensitive call sites) underlies the quantity-aware pantry-overlap deduction described in Agent 2, so pantry stock consumed by one slot is reflected when scoring later slots and swaps in the same plan.
- Accepts chat-driven edits from the Orchestrator's conversational session (F7) — same storage, no separate write path
- Updates after each shop: marks pantry items as added from grocery list
- Expires pantry items after 7 days unless refreshed (V2 — manual pantry entry itself is MVP, this automation is not)

**Data returned to Orchestrator:** Pantry contents (name + quantity), allergen list, disliked ingredients

**Implementation:** Custom-authored MCP server for pantry/constraint storage. The identity-match and unit-conversion mechanisms described above are plain library functions (`src/lib/grocery/identityMatch.ts`, `src/lib/grocery/unitConversion.ts`) called directly from grocery aggregation and the Orchestrator — not routed through this MCP server, and not a conversational agent with its own call loop the way Agent 1's Orchestrator or the AI-composition/plan-critique flows are; the LLM call inside `identityMatch.ts` is a single narrow forced-tool-call classification, not a reasoning loop. Pantry data itself: stored locally in MVP (user's browser/account). Cloud-synced in V2.

---

## Agent 4 — Calendar Export Agent (No API)

**Role:** Converts the weekly meal plan into a downloadable `.ics` calendar file.

**What it does:**
- Triggered when user taps "Export to Calendar"
- Receives meal plan from Orchestrator: 21 meals × (name, meal type, time slot, macro summary)
- Hand-built RFC 5545 (.ics) generator — no external calendar library — produces one calendar event per meal: event title = meal name, description = macro summary, time = meal type (breakfast 8am / lunch 12pm / dinner 7pm)
- Outputs a downloadable `.ics` file compatible with Google Calendar, Apple Calendar, Outlook

**API:** None — runs entirely client-side

---

## How the Agents Work Together — Full Flow

```
1. User completes onboarding (F1, F2) and, optionally, pantry entry (F5, moved up from V2)
   └── Pantry Agent stores constraints: goal, macros, allergies, preferences
   └── Pantry *inventory* can now be populated here too (Step 2 of the PRD flow, or later
         via the conversational assistant, F7) — no longer gated to V2

2. User taps "Generate meal plan"
   └── Orchestrator reads Pantry Agent's stored constraints and any pantry inventory
   └── Orchestrator calls Recipe Agent × 21 (3 meals × 7 days), all 21 concurrently (OQ7)
       ├── Each slot independently: queries Spoonacular with macro + dietary constraints,
       │     plus pantry ingredients as a soft `includeIngredients` preference if entered
       ├── If no macro match → cascade tolerance widening (up to 3 rounds, ±10%→±20%→±30%)
       ├── If cascade fallback is exhausted, or every candidate ignores entered pantry
       │     ingredients → AI composition/edit fallback: Claude proposes a recipe or edit,
       │     every ingredient grounded via Spoonacular's ingredient endpoint (see Agent 2)
       ├── If Spoonacular is unavailable/quota-exhausted → serve cached last-successful
       │     plan with a banner instead of failing
       ├── Ranks its own candidates at the matched tier by weighted deviation from the
       │     per-meal target (with a small pantry-overlap deduction) — deterministic
       │     score, not AI-judged — see Agent 2
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
   └── If still outside ±5% after the cap → the plan is generated as-is rather
         than the system claiming an exact match it didn't hit

3a. Orchestrator runs the post-generation plan critique (live in production)
    └── One Claude call reviews all 35 claimed slots at once, flags any that look
          repetitive or macro-off, with a reason for each
    └── For each flagged slot: Recipe Agent is asked for one real alternative (same
          cascade, same constraints, excluding every recipe already used in the plan)
    └── Orchestrator compares the alternative's macro-deviation score to the
          original's, deterministically — only replaces the slot if the alternative
          is a real improvement, and for a repetition flag, only if it doesn't
          introduce a different duplicate
    └── Skipped if the critique call fails (API key is now configured, so this is an
          error-fallback path, not the default) — the plan from steps 2-3 stands as
          generated either way

4. Orchestrator aggregates grocery list
   └── Scales ingredient quantities: (amount ÷ servings) × frequency
         — live-confirmed correctly implemented July 2026 (previously ingredients
           weren't scaled at all, inflating a real weekly total 7-8x)
   └── Deduplicates across all 35 meal/snack slots (7 days × 5 slot types)
   └── Removes, or quantitatively reduces, any items already in Pantry Agent
         inventory depending on whether a comparable structured quantity was
         given — now MVP, not V2-gated (see PRD F3/F5)

5. Orchestrator renders outputs
   ├── Meal plan (F3): 7-day view with per-meal macros
   └── Grocery list (F4): deduped items

6. User taps "↺ Swap meal" — or asks the conversational assistant (F7) to do the same
   └── Orchestrator calls Recipe Agent for one slot
       ├── Excludes the rejected recipe ID
       ├── Applies the same cascade fallback as initial generation, then the AI
       │     composition/edit fallback if cascade is exhausted
       ├── If both fallbacks fail → shows the blocking-constraint prompt scoped to that
       │     slot, never a dead end
       ├── Returns a new recipe for that slot only
       └── Updates grocery list and nutrition totals

6a. At any point in Steps 2–5, user chats with the conversational assistant (F7)
    └── Free-text request (edit pantry, swap a meal, change a constraint) is parsed and
          mapped to the same action the corresponding UI control would trigger — no
          separate mutation path
    └── Ambiguous requests, or ones that would violate a hard constraint (e.g. an allergen),
          get an explanation instead of being executed

7. User taps "Export to Calendar"
   └── Calendar Export Agent generates .ics file → downloads

8. Week 2+ (loop)
   └── Orchestrator pre-fills same goal from Pantry Agent
   └── New plan generated with fresh Spoonacular query
```

---

## AI vs. Rule-Based: Why This Needs AI

| Decision | Rule-based? | Why AI wins |
|---|---|---|
| Match 21 recipes to macro targets | Partial (filter) | Per-meal filtering, cascade widening, candidate ranking, and weekly reconciliation are all deterministic (see rows below) — Claude's actual role is deciding what per-meal targets/params to request and translating blocked states into clear user guidance, not solving a combinatorial search itself |
| Cascade tolerance fallback | Yes (logic) | Simple rules work here — implemented as structured retry logic, not AI |
| Candidate ranking within a tolerance tier | Yes (logic) | Weighted-deviation score, deterministic sort — no AI judgment |
| Weekly reconciliation after all 21 meals selected | Yes (logic) | Sum vs. target, re-query slack meals — deterministic, not AI |
| Ingredient deduplication | Yes (logic) | Keyed on Spoonacular's ingredient `id` + `measures.metric` unit conversion — deterministic aggregation once the right key is used, not raw name-string matching, no AI needed |
| Serving-size scaling | Yes (formula) | `(amount ÷ servings) × frequency` — deterministic |
| Grocery list generation | Yes (aggregation) | Deterministic once recipes are selected |
| AI composition/edit fallback (when cascade fails or pantry is ignored) | Partial | Deciding what recipe/edit to propose given pantry + macro constraints is a judgment call AI is good at; the resulting macros are never AI-estimated — every ingredient resolves to Spoonacular's ingredient endpoint and is summed deterministically, same as the dedup row above |
| Snack/add-on selection to close a macro gap | Partial | Same split as above: Claude picks which single-ingredient item makes sense, the calorie-share cap and macro math are deterministic |
| Chat-driven pantry/meal/constraint edits (F7) | No | Free-text intent parsing needs an LLM; the resulting mutation is the same deterministic action the UI already performs — no new write path |
| Post-generation plan critique (which slots to reconsider) | No | Spotting a repeated recipe or an outlier macro fit across 35 slots at once is a holistic pattern-match no per-slot deterministic step can perform — nothing else in this flow ever sees the whole week simultaneously |
| Accepting or rejecting a critique-flagged repair | Yes (logic) | Real macro-deviation score comparison plus a duplicate-title check, both deterministic — the critic flags candidates for a second look, it never decides which result is better |

**Bottom line:** AI is used where human-like reasoning across multiple constraints — or free-text intent — is required (recipe selection and composition, chat understanding). The moment a macro number is involved, it's computed deterministically from Spoonacular's data, never estimated by the LLM. Deterministic logic handles everything else.

---

*MacroMap · AI Agents v1 · July 2026*
