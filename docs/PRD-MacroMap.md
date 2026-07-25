# PRD — MacroMap MVP

> **Status:** Draft v1 | **Date:** June 2026 | **Scope:** MVP only

---

## 1. Summary

MacroMap is an AI-powered meal planning app that turns a weekly nutrition goal ("hit 150g protein on a $90 budget") into a ready-to-shop grocery list and a full week of meals. It replaces the fragmented workflow of juggling multiple apps, websites, and spreadsheets that people cutting or bulking currently rely on. This PRD covers the MVP — the smallest version of the product that proves the core loop works and earns its first paying users.

---

## 2. Contacts

| Name | Role | Responsibility |
|------|------|---------------|
| Satya | Founder / PM / Designer | Product vision, prioritisation, onboarding flow, meal plan UI |
| Claude | Engineer / QA | Technical architecture, MCP integrations, acceptance criteria validation |

---

## 3. Background

### What is this about?
People who want to eat to a specific nutrition target — particularly those cutting (losing fat) or bulking (building muscle) — spend 2–3 hours every week planning meals across multiple tools. They use recipe sites to find ideas, nutrition apps to check macros, notes apps to build grocery lists, and mental maths to stay on budget. None of these tools talk to each other.

### Why now?
Two things have changed recently that make this buildable in a way it wasn't before:

1. **High-quality nutrition and recipe APIs exist.** USDA FoodData Central provides authoritative macro data for free. Spoonacular provides unified recipe + nutrition data in a single API call, eliminating the complex ingredient-parsing layer that previously made this type of product hard to build accurately.

2. **AI can reason across data sources.** The Model Context Protocol (MCP) lets an AI agent pull from recipes, nutrition data, price estimates, and personal pantry information simultaneously — and make decisions that require all four at once. That cross-source reasoning is the core of MacroMap.

### Why does the problem go unsolved today?
Existing tools solve one piece each. MyFitnessPal tracks macros. Mealime suggests recipes. Cronometer measures nutrients. Prospre gets furthest of any competitor identified so far — it pairs USDA-grounded macro-fit meal generation with dietary/dislike filtering and grocery lists in a single app — but has no dollar-budget input and no pantry awareness (both deliberate omissions per its own team). None connect all four data points — recipe + macros + price + personal preferences — into a single planning flow.

---

## 4. Objective

### Goal
Help people who are cutting or bulking eat to their nutrition targets every week — without the planning overhead.

### Why it matters
- **For users:** Reclaim 2+ hours every week. Stick to their goals longer because the plan is done for them.
- **For the business:** Own the meal planning category for fitness-focused users — a high-intent, high-retention, word-of-mouth-driven segment.
- **Strategic fit:** AI-native product in a space where incumbents are traditional CRUD apps. First mover advantage on contextual reasoning across nutrition, recipes, budget, and pantry.

### Key Results (MVP, measured at 6 months post-launch)

| # | Key Result | Target |
|---|-----------|--------|
| KR1 | Pro subscribers | 1,000 paying users |
| KR2 | Weekly meal plan generation rate | 60% of active users generate a new plan each week |
| KR3 | Free-to-Pro conversion | 15% of free users upgrade within 90 days |
| KR4 | Onboarding completion | 70% of new users complete onboarding and generate their first meal plan |
| KR5 | 30-day retention | 50% of users return in week 4 |

**Capacity dependency — reversed AGAIN, back to a real risk (2026-07-22, see OQ6):** the "~938–1,876 generations/week, comfortably above what KR2 needs" conclusion below was itself based on a stale model — it assumed all 3 meal types collapse to one shared Spoonacular query per plan, an assumption a later session invalidated by giving each meal type a realistic (non-uniform) share of daily macros instead of an even 1/3 split, which means meal types no longer reliably share a cache key. **A live recompute against a representative 15-profile mix (7 simple/unconstrained, 5 moderately constrained, 3 heavily constrained — weighted ~45/33/20% to approximate a realistic user base, not cherry-picked toward either extreme) found real cost per generation averaging at least ~34.2 Spoonacular points** (a conservative floor — 5 of the 15 profiles exhausted a full ~46–48pt test key mid-generation before finishing, so their true cost is higher than what's counted here, meaning the real average is worse than this floor, not better). At the $29/month tier's 1,500 points/day: **real capacity ≈ 44 generations/day (~306/week) at best — roughly HALF of the ~600/week (~86/day) KR2 needs for KR1's full 1,000-subscriber target, not comfortably above it.** Translated to a subscriber count: at KR2's assumed 60% weekly-generation rate, ~306/week supports only ~510 active users system-wide (free + Pro combined, since capacity is shared) before hitting the ceiling — likely well before KR1's 1,000 *paying* subscribers, given free users normally outnumber paid ones in a freemium funnel. **This directly contradicts the "tier-upgrade trigger point is now much further out than previously thought" line in OQ6 below — the opposite is true: the tier-upgrade trigger needs to be treated as a near-term concern, not a distant one, until this is re-confirmed with real production data.** Not yet root-caused exactly which new mechanism is driving the higher cost (candidates include: meal-type queries no longer sharing a cache key per the above, the post-generation plan-critic/repair pass triggering a real new Spoonacular query for every flagged slot, and/or reconciliation/exhaustion retries) — flagged as the natural next investigation if this number matters enough to chase further, not chased down this session.

---

## 5. Market Segments

### Primary — People Cutting or Bulking
**Who:** Gym-goers, athletes, and fitness-focused individuals (18–35, US) who are actively tracking body composition goals. They already know what macros are and have a target in mind. They are disciplined, data-driven, and willing to pay for tools that save them time and improve their results.

**Their job:** "Plan a week of meals that hits my protein target and doesn't blow my budget — without spending my Sunday doing it manually."

**Constraint:** They have tried existing apps and found them incomplete. They won't tolerate inaccurate macro data.

**Example personas:** Marcus (bulking, $120/week budget, immediate Pro buyer) and Priya (cutting, $75/week, will pay if the first week saves her meaningful time).

### Secondary — Budget-Conscious Healthy Eaters
**Who:** Students and busy professionals who care about eating well but are constrained by budget more than by precise macro targets. They will enter the product through the free tier.

**Their job:** "Tell me what to buy this week that is healthy and won't cost more than $50."

**Constraint:** Price-sensitive. Will not pay $9/month without a proven savings track record. Slow to convert.

**Example persona:** Jordan (student, $50/week hard limit, free tier entry).

---

## 6. Value Propositions

### What jobs does MacroMap do for users?

| Job | Current pain | MacroMap's gain |
|-----|-------------|-----------------|
| Plan meals that hit macro targets | Hours of manual cross-referencing across apps | AI generates a compliant week in seconds |
| Build a grocery list | Manual notes, duplicate items, missing quantities | Deduped, consolidated list auto-generated from the meal plan |
| Stay on grocery budget | No tool connects recipes to real prices | Price estimates per ingredient, total cost shown before shopping |
| Avoid buying what's already at home | Re-buying ingredients wastes money | Pantry log prevents redundant purchases |
| Eat varied meals (not the same 4 dishes) | Recipe discovery is disconnected from macro tracking | App suggests varied recipes that all fit the targets |

### What makes MacroMap better than alternatives?

Competitors solve one dimension — Prospre solves two (macro-fit generation + meal planning) but stops short of budget and pantry. MacroMap solves the intersection of all four:

> "Make this chicken stir-fry — you already have soy sauce, it hits your protein target, it fits your budget, and you've never rated it below 4 stars."

No competitor today can make that recommendation — it requires macro precision, meal planning, budget awareness, and pantry awareness together, and MacroMap is the only one holding all four data points simultaneously.

---

## 7. Solution

### 7.1 User Flow

```
Onboarding → Set Weekly Goal → Generate Meal Plan → View Grocery List → Track Progress → (repeat weekly)
```

**Step 1 — Onboarding (one-time)**
User enters: weight, height, age, activity level, goal (cut / bulk / maintain), dietary preferences, allergies, dislikes.

App calculates TDEE using the Mifflin-St Jeor formula and suggests macro targets. User can accept or manually override. No account needed to try — guest state persists in browser localStorage so a refresh or accidental close doesn't lose progress (see F1).

**Step 2 — Set Weekly Goal**
User confirms or adjusts their weekly macro targets, optional grocery budget, and zip code (used for regional price estimates — see F2, F4). This becomes the constraint the meal plan is built around. Held in guest session until account creation; saved to profile and pre-filled on all future weeks once an account exists.
- Weekly calorie target = daily TDEE × 7 (calculated in Step 1, surfaced here as a weekly number for clarity)
- Budget is optional. If not set, F4 still displays total cost estimate as informational only — no filtering or warnings applied. On Free tier, an entered budget is never silently ignored — see F2/F3 for the explicit messaging.
- **Pantry (optional):** user can list ingredients currently on hand with rough quantities, moved up from V2 into this step (see F6). If provided, Step 3's generation is biased toward recipes that use them and excludes them from the Step 4 grocery list; if skipped, generation proceeds exactly as before. Editable at any point via the conversational assistant (F11), not just here.

**Account creation — resolved timing:** guests can complete the full loop (onboarding → plan → grocery list, Steps 1–4) with no account. The signup wall appears at Step 5 (Track) — saving progress, viewing history, or returning to a plan across sessions requires an account. This removes friction before the user has seen the product's value, maximizing onboarding completion (KR4).

**Step 3 — Generate Meal Plan**
App generates 3 meals per day for 7 days. Each meal is matched to:
- The user's macro targets (protein, carbs, fat, calories)
- Their dietary preferences and allergies
- Their budget (if set)
- Pantry contents, if entered (biases recipe selection toward on-hand ingredients — see F3, F6). No longer V2-gated; barcode-scanned entry (F8) is the only pantry piece remaining V2.
- When no Spoonacular recipe matches after cascade fallback, or pantry-fit is poor, the AI composition fallback proposes a recipe or a small snack/side add-on to close the gap — see F3.

User can swap individual meals they don't like, or ask the conversational assistant (F11) to adjust a meal, the pantry, or a constraint in plain language at any point in Steps 2–6.

**Step 4 — Grocery List**
App generates a deduped shopping list from the meal plan — consolidating quantities across all recipes (e.g. if 4 meals need chicken breast, one line item shows the total quantity needed). Price estimates shown per item and as a weekly total.

User can manually correct any price estimate.

**Step 5 — Track**
Nutrition dashboard shows daily and weekly progress against targets. Updates as the user logs meals eaten.

**Step 6 — Weekly Cycle (every week)**
On day 7 (or whenever the user is ready), a "Plan next week" prompt appears. App pre-fills the same macro targets and budget from the user's saved profile (Step 2 baseline). Any edits made in Step 6 are saved back to the profile and become the new baseline for future weeks — there is no session-only state. User can adjust, then generate a new plan. Previous week's plan is archived and viewable. V2: meal ratings from the prior week are passed to F3 as an exclusion list — low-rated recipes are added to Spoonacular's `excludeIds` param so they don't reappear in future plans.

---

### 7.2 Epics

Features are grouped into six epics. Each epic maps to a coherent unit of user value that can be planned and shipped independently.

| Epic | Features | Release | Description |
|---|---|---|---|
| **E1 — Onboarding & Goal Setting** | F1, F2 | MVP | First-run experience: TDEE calculation, macro targets, dietary constraints |
| **E2 — Meal Planning** | F3, F6, F9, F11 | MVP | AI-generated weekly plan, pantry-aware and macro-matched recipes, recipe video links, conversational plan assistant |
| **E3 — Grocery Management** | F4 | MVP | Deduped shopping list, price estimates, manual overrides, calendar export |
| **E4 — Tracking & Progress** | F5 | MVP | Daily and weekly nutrition dashboard, meal logging |
| **E5 — Personalization (V2)** | F7, F8 | V2 | Meal ratings, barcode scanning for pantry — closes the weekly loop |
| **E6 — Discovery & Integrations** | F10, Reddit deep-link | MVP | Calendar export, community inspiration links |

**MVP critical path:** E1 → E2 → E3 → E4 (in that order — each epic depends on the previous)
**Rescoped from the original plan:** F6 (pantry log — manual entry, generation-time use, grocery-list exclusion) moved from E5/V2 into E2/MVP so pantry can bias recipe selection from day one, per the pantry-first architecture change. Only barcode scanning (F8) and meal ratings (F7) remain V2.

---

### 7.3 Key Features

#### F1 — TDEE Calculator & Macro Onboarding (P0) · E1 Onboarding & Goal Setting
- Inputs: weight (lbs **or** kg — user selects unit, app converts to kg immediately for all calculations), height (ft/in **or** cm — same unit-toggle pattern as weight, converts to cm immediately), age, biological sex (male/female — required input to the Mifflin-St Jeor formula's BMR constant; a gap discovered and resolved during implementation, not present in earlier drafts of this section), activity level (sedentary / lightly active / active / very active), goal (cut / bulk / maintain)
- All internal calculations use kg/cm — Mifflin-St Jeor formula and macro targets (g/kg bodyweight) both operate in metric
- Formula: BMR = 10 × weight_kg + 6.25 × height_cm − 5 × age + (5 if male, −161 if female); TDEE = BMR × activity multiplier:

| Activity level | Multiplier |
|---|---|
| Sedentary | 1.2 |
| Lightly active | 1.375 |
| Active | 1.55 |
| Very active | 1.725 |

- Input validation: age 18–100 (raised from 13 in audit round 2, July 15 2026 — Mifflin-St Jeor isn't validated for adolescents, and this app's own extreme inputs could compute a sub-900-calorie "maintenance" target for a minor), weight 30–300kg, height 100–250cm — out-of-range values show an inline error and block submission
- Output: suggested daily calorie target + macro split (protein, fat, carbs)
- Default macro splits by goal:

| Goal | Protein | Fat | Carbs |
|------|---------|-----|-------|
| Cut | 2.2g/kg bodyweight | 25% of calories | Remainder |
| Bulk | 1.8g/kg bodyweight | 25% of calories | Remainder |
| Maintain | 1.6g/kg bodyweight | 30% of calories | Remainder |

- User can nudge any value manually after seeing the suggestion
- Guest session (no account yet): onboarding inputs and generated plan persist in browser localStorage. Account creation is only required at Step 5 (Track) to save/sync across sessions — see Section 7.1 Step 1/2 for the resolved account-timing decision.
- **Implemented (July 2026, `web/src/lib/tdee.ts`, `epic-e2-wip` branch, not yet live-verified):** daily calorie target now applies a real goal-based deficit/surplus (cut ×0.8, bulk ×1.1, maintain ×1.0) instead of always equaling TDEE — a "cut" plan previously only reallocated macros at maintenance calories. Protein stays keyed to bodyweight (g/kg) so it doesn't shrink along with the deficit.

#### F2 — Preference & Constraint Input (P0) · E1 Onboarding & Goal Setting
- **Tier: Free** — allergy and dietary filtering is a safety feature, never gated
- Dietary restrictions: vegetarian, vegan, gluten-free, dairy-free, halal, kosher
- Allergy flags: nuts, shellfish, eggs, soy (free text + common presets)
- Dislikes: free text (e.g. "no Brussels sprouts")
- Weekly grocery budget: optional, numeric input in USD, visible on both tiers
  - **Pro:** entering a budget activates budget-aware filtering in F3
  - **Free:** budget field shown with a "Pro" lock badge and tooltip ("See if your plan fits — upgrade to filter recipes by budget"); if the generated plan's actual cost exceeds the entered budget, F4 shows an inline banner ("This week's plan is $X over your budget — upgrade to Pro to filter recipes that fit") rather than silently ignoring the input
- **Zip code (US):** collected during onboarding, visible on both tiers. Used to derive the region passed to the Price Agent's Tavily fallback (built July 2026 — Spoonacular's own ingredient cost data is now the primary source and isn't region-parameterized; region only matters when Spoonacular has no cost data for an ingredient) for F4's price estimates — see ai-agents.md Agent 3. Not required to complete onboarding on Free tier (no price estimates shown, F4); prompted before first Pro-tier plan generation if not already provided

#### F3 — Meal Plan Generation (P0) · E2 Meal Planning — Free + Pro
- **Free:** 3 meals/day, 7 days, macro-matched, allergy/dietary filtered, no budget constraint applied
- **Pro:** all of the above + budget-aware filtering (recipes chosen to keep weekly grocery total within budget)
- 3 meals per day × 7 days = 21 meals per week
- Recipes sourced via **Spoonacular API** (`/recipes/complexSearch`) — queries by macro targets, dietary filters, and excluded allergens in a single call; returns recipe + per-ingredient nutrition data together
- Query includes `addRecipeInformation=true` and `fillIngredients=true` so each returned recipe's `extendedIngredients` array is fully populated with a `measures` object (`us` and `metric` amount + unit) in the same call — this same payload feeds both the OQ4 serving-scaling math and the F4 grocery-dedup/unit-conversion step below, so no separate ingredient-conversion API call is ever needed. These two flags each add 0.025 points per recipe returned (confirmed live against a real key — see OQ6). **Candidate count, corrected to match what actually shipped (OQ6/OQ7):** the original plan here was a distinct query per meal-type group (3–5 candidates for a unique constraint tuple, 7–8 for a shared one) — engineering discovered during the E2 build that F1's per-meal target is identical across breakfast/lunch/dinner (daily target ÷ 3 uniformly, not a meal-type-specific split), so *every one of the 21 slots* shares one constraint tuple, not three. The shipped design reflects that: **one shared query, `number=60`, serves the entire 21-slot plan** (deduped across concurrent slot requests so it's genuinely one Spoonacular call, not 21) — cheaper than the original 3-distinct-query model, not more expensive. See OQ6 for the resulting real capacity ceiling.
- Spoonacular returns macro data **per serving** — this is what is displayed on each meal card in the plan view, so users see accurate per-meal macros before committing to the grocery list
- Each recipe must fit within the user's macro targets (±10% tolerance per meal) — cascade fallback per OQ2
- **Pantry-aware querying (moved up from V2, see F6):** if the user has entered pantry items, they're passed to the Spoonacular query as a soft preference (`includeIngredients`) alongside the existing hard filters, so candidates that use on-hand ingredients rank higher; this never overrides macro/dietary/allergen constraints, it only biases which matching recipe is preferred.
- **Candidate selection when multiple recipes match a tier:** deterministic, not AI-judged. Score = weighted deviation from the per-meal target — `|protein_actual − protein_target| / protein_target × 2 + |calories_actual − calories_target| / calories_target` (protein weighted 2× per the macro-split priority in F1), with a small deduction for pantry-ingredient overlap — lowest score wins, with budget-compliant candidates ranked first (Pro only) and the cheapest macro-matching candidate appended as fallback-of-last-resort only if none are budget-compliant. Ties broken by: cheapest (Pro only) → highest Spoonacular `aggregateLikes`. Variety ("not used elsewhere this week") is enforced separately, in the cross-slot claim-resolution pass (OQ7) — not as a ranking tie-break here, since all 21 slots resolve concurrently and no slot knows what others picked at ranking time. See Agent 2 in ai-agents.md.
- Filters out any recipe containing allergens or disliked ingredients (passed as `excludeIngredients` param) — this exclusion is a hard filter applied at every cascade tier, never widened or relaxed
- **Budget cascade fallback (Pro only):** if no recipe satisfies both macro tolerance and budget at any OQ2 tier, drop budget filtering for that meal and select the cheapest macro-matching option instead; label the meal "Closest to your budget — $X over" with the delta shown. Never blocks plan generation on budget alone.
- **AI composition/edit fallback (new):** if Spoonacular's cascade fallback still returns nothing at ±30% tolerance, or the only matches ignore pantry ingredients entirely despite the user having entered them, Claude proposes a recipe — either a new one built around pantry ingredients + the macro target, or an edit to a returned candidate (e.g. swap/add one ingredient). This is a per-slot fallback, not the default path: Spoonacular search runs first for all 21 slots per OQ7's concurrency model, and this only triggers for the specific slot(s) that fail. **Grounding rule:** Claude decides *what* the recipe/edit is; it never estimates the macro numbers. Every ingredient in the proposal is resolved through Spoonacular's ingredient-level endpoint (`/food/ingredients/search` + `/food/ingredients/{id}/information`) and macros are summed deterministically from that data, the same way grocery-list dedup already works off ingredient IDs (see F4). If an ingredient can't be resolved to a Spoonacular ID, it's swapped for one that can, or the fallback is abandoned in favor of the OQ2 "blocking constraint" prompt.
- **Implemented (July 15 2026, `web/src/lib/mealplan/aiMealComposition.ts` + `mealProposer.ts`, `epic-e2-wip` branch, NOT yet live-verified end-to-end):** built after a live extreme-profile test found several breakfast/lunch slots with zero Spoonacular recipe match at any cascade tier. Split of responsibility matches the grounding rule above exactly — Claude proposes a dish name + a role-tagged ingredient list (protein/carb/fat/fixed-garnish), never a quantity or macro number; a deterministic solver sizes each ingredient and sums real Spoonacular macros. **A second guardrail was added after the first live spike attempt:** naively sizing whatever ingredient Claude names to hit the target can demand an unrealistic portion (a real case needed 346g of tofu to hit a 31g-protein target, and that amount of tofu alone already overshot the fat target before anything else was added) — a portion-realism bound per role now rejects the whole composition outright if any ingredient's solved amount falls outside a normal serving range, regardless of how good the ingredient choice was. The LLM is also explicitly instructed to pick a protein source dense enough for the target within a normal portion (seitan instead of tofu closed the same real case at a realistic 140g). Safety for these open-ended, LLM-proposed ingredients uses a separate, stricter gate than the fixed-pool one below — an unrecognized ingredient defaults to *unsafe*, not "not flagged," since this pipeline doesn't control what Claude proposes the way it controls the fixed 9-ingredient pool. **Deferred, not blocking:** this entire fallback is gated behind `ANTHROPIC_API_KEY`, which is not yet configured in the working environment — Satya's explicit direction this session was to defer key-wiring for later. Everything downstream of a proposal (grounding, the safety gate, the portion bound) is real, tested code and was verified against real Spoonacular data during development; only the actual Claude API round-trip has never run.
- **Real safety gap found and fixed (July 15 2026) in the existing snack/add-on gap-closer, not the new AI path:** confirmed neither the composed-snack pool nor the add-on selector had *ever* checked a profile's allergies, dietary style, or dislikes — a user with a nut allergy (a first-class F2 preset) could be served almonds/peanut butter/walnuts in a snack or add-on, and a vegan user could be served dairy. Live-confirmed as a real, not theoretical, gap before fixing. Now enforced via the same exclusion words already used to build Spoonacular's `excludeIngredients` param, fail-closed, with curated per-ingredient tags for the fixed 9-ingredient pool (an ambiguous ingredient like "protein powder," whose real formulation could be whey/soy/plant-based, defaults to the safer excluded tag rather than assuming). Live-verified: regenerated a nut-allergy profile and scanned the full rendered page for nut terms — zero matches.
- **Pantry and price parity fix (July 15 2026):** the same composed snack/add-on system also had zero pantry- or budget-awareness, unlike the recipe-search path's real `pantryOverlapDeduction`/`budgetCompliant` mechanisms. Fixed the same day: a pantry match is preferred outright; failing that, and only when budget-aware (Pro + a budget set), the cheaper *half* (minimum 2) of a role's safe options are preferred over the pricier half — not just the single cheapest. **That distinction mattered in practice:** a live test with a tight budget on Pro tier first showed the identical snack combo 14/14 times across the week, because the real fixed-pool costs are never close enough for a percentage tie-band to help (the 2nd-cheapest option in every role is 43-570% pricier than the cheapest) — a strict "prefer only the single cheapest" rule collapses to zero variety regardless of tolerance. The cheaper-half rule fixed this; re-verified live, the same profile now alternates between 2 real combos.
- **Post-generation plan critique + repair (new, built July 15 2026, `web/src/lib/mealplan/planCritic.ts` + `planRepair.ts`):** following an engine audit that live-tested variety/precision/preference-adherence across several profiles, added one more pass after everything above: a single Claude call reviews the entire generated week at once — something the per-slot pipeline structurally can never see, since no single slot's logic has visibility into "this exact recipe already appears 4 times elsewhere in the plan." The critic flags specific slots as repetitive, macro-missing, or otherwise worth a second look — a genuine holistic judgment call, not arithmetic. The accept/reject decision on any flagged slot is 100% deterministic: re-fetch a real alternative via the existing swap mechanism (respects every constraint already in place — allergies, diet, budget, pantry), score both candidates with the same weighted-deviation formula used everywhere else in F3, and only replace if the alternative is meaningfully better — for a repetition flag, only if it doesn't just trade one duplicate for a different one. Ties or ambiguous cases keep the original. **Verified without a real API key:** the deterministic half of this (the actual swap-and-compare mechanism) was proven against a real generated plan by manually acting as the critic and driving the real production code — a genuine macro-miss case (2.51g carbs against a ~60g target) was correctly repaired, and a contrived duplicate-trading case was correctly refused. Only the Claude call itself (`critiquePlan`) is unverified live, same deferred status as the AI composition fallback above.
- **Live-tested engine audit (July 15 2026), the headline finding:** across 4 live-generated profiles (unrestricted baseline, aggressive bulk, vegan+nut+soy allergy, tight-budget Pro), real recipe variety was perfect every time (21/21 distinct titles across the week, zero repeats) and zero allergen/dislike/diet violations ever reached the screen, including under the hardest constraint stack tested. But the vegan + nut allergy + soy allergy combination — a real, plausible user segment, not a synthetic edge case — collapsed a full week's plan to **17% of its calorie target**: two of the fixed pool's three macro roles (protein: all dairy-tagged; fat: all nut-tagged) had zero safe options left, and most breakfast/lunch recipe slots were also blocked by genuine corpus scarcity at that macro density. This is a real, unresolved product gap, not yet fixed: the fixed pool needs 2-3 more vegan+nut+soy-safe options per affected role (e.g. pea protein powder or hemp hearts for protein, sunflower seed butter or chia seeds for fat) to close it. See `engine-audit-2026-07-15.md` for the full methodology and per-profile results.
- **Snack/add-on gap-closer (new):** rather than distorting a recipe's proportions to hit a macro target, the Orchestrator can attach one small, single-ingredient add-on (fruit, nuts, yogurt, protein powder, etc.) to a meal to close the remaining gap. Capped at one add-on per slot and ≤15–20% of that meal's calories, so the meal still reads as realistic rather than "recipe plus a disguised shake." Add-on macros are resolved the same way as the composition fallback above — via Spoonacular's ingredient endpoint, never LLM-estimated. This is the **first-choice** gap-closer, tried before further cascade tolerance widening or the weekly reconciliation requery below.
- **Weekly reconciliation pass:** per-meal tolerance (±10–30%) does not guarantee the weekly aggregate lands on target, so after all 21 meals are selected, sum actual protein/calories/carbs/fat and compare against a tighter ±5% weekly band. If outside band, first try attaching a snack/add-on (above) to the meal(s) furthest from target; only if that can't close a large enough gap does the Orchestrator re-query up to 3 meals with the most slack, with bounds nudged toward the deficit. Capped at 3 extra queries per plan to protect API quota (see Section 7.4 capacity note). If still outside ±5% after the cap, the weekly dashboard (F5) shows the actual delta rather than implying an exact match.
- User can tap "swap meal" on any individual meal to get an alternative (triggers a new Spoonacular query with the same constraints, excluding the rejected recipe), or ask the conversational assistant (F11) to do the same in plain language. If cascade fallback and the AI composition fallback both fail to find a replacement for that single slot, show the same "no match — here's the blocking constraint" prompt used at OQ2's final tier, scoped to just that meal — never a dead end
- **Spoonacular outage/quota fallback:** if the API errors or the daily point quota is exhausted, serve the user's last successfully generated plan from cache with a banner: "Using last week's plan — live generation is temporarily unavailable, try again shortly." Never show a blank state or unhandled error
- **Implemented (July 2026, `web/src/lib/mealplan/orchestrate.ts`, `epic-e2-wip` branch, not yet live-verified):** the per-meal protein-floor check (any meal below ~12% of the daily protein target) is no longer monitoring-only — each violation now gets a targeted fix (a protein-specific add-on first, then a nudged-bounds recipe swap requiring a real protein improvement) after the day's regular gap-closing phases run.
- **Implemented and live-verified (July 2026, `web/src/lib/mealplan/orchestrate.ts` + `retryBudget.ts`, `epic-e2-wip` branch):** each day now gets its own fresh reconciliation retry budget (9 cost-units) instead of all 7 days plus protein-floor fixes sharing one pool sized for the old single-weekly-pass model. Live-tested against real Spoonacular/Supabase (cut-goal profile): confirmed day 0 spending its full budget no longer starves day 1's allowance; weekly aggregate landed within ±5% on all four macros (calories -4.0%, protein -2.7%, carbs -2.1%, fat +1.7%).
- Two distinct server-side caches (see ai-agents.md Agent 2 for detail): (1) a cross-user query-result cache keyed on shared constraints (macro range, diet, excluded ingredients — deliberately excluding the per-user `excludeIds` list, which would fragment hit rate to near-zero) to minimise API point consumption, and (2) a per-user last-successful-plan cache, used only as the outage/quota-exhaustion fallback above — not the same mechanism

#### F4 — Grocery List (P0) · E3 Grocery Management — Free + Pro
- **Free:** deduped grocery list with quantities, no price estimates shown
- **Pro:** price estimates per ingredient, weekly total cost, manual price override
- Auto-generated from the weekly meal plan
- **Dedup key:** ingredient `id` from Spoonacular's `extendedIngredients` (fallback: normalized/descriptor-stripped name if `id` is missing) — never the raw ingredient display string. Raw-string matching fails on real recipe text (e.g. "1 lb boneless skinless chicken breast" vs. "16 oz raw chicken" vs. "2 cups chopped chicken breast" would be treated as three separate items); Spoonacular's canonical `id` is what makes these the same grocery-list line.
- **Quantity scaling (built + corrected July 2026):** each recipe's ingredient amounts are scaled to reflect only the portion actually planned for that one meal — the same per-slot macro-fit factor applied everywhere else, divided by the recipe's native serving count (Spoonacular's ingredient amounts are for the whole recipe batch, e.g. "makes 4 servings," not one serving). Live-tested: this single fix took one real plan's grocery total from an implausible $1,085/week to a plausible $140.78/week — the dominant lever by far, ahead of anything about pricing accuracy below.
- **Unit reconciliation:** convert matched entries to a common unit using the `measures.metric.amount`/`unitShort` already returned in the same complexSearch call (see F3's `addRecipeInformation`/`fillIngredients` note) — sum locally, no extra API call. If `metric.unitShort` still doesn't match across matched entries for the same `id` (or `measures` is missing), don't force a merge — list as a separate line under that ingredient with a "combine manually" prompt, same fallback pattern as the price-unavailable case below. Volume-based measures (e.g. "chopped," "cups") converted to weight are Spoonacular's own density estimate, not exact.
- Ingredients deduplicated and quantities summed across all recipes using the key and unit rules above
- **Pantry subtraction (built July 2026):** if a matching pantry item (F6) has a structured, comparable quantity, the needed amount is reduced by what's already on hand instead of dropping the ingredient entirely; falls back to full exclusion when the pantry entry has no structured quantity or an incompatible unit — see F6.
- **Price estimate per ingredient — Spoonacular primary, Tavily fallback (switched July 2026):** Spoonacular's own ingredient-cost data (`estimatedCost`, already used elsewhere for the recipe-composition fallback) is queried first — a structured number, not text to parse. Only when Spoonacular has no cost data for an ingredient does it fall back to **Tavily Search API** (1,000 free credits/month, no credit card required), by US region. *(Original design used Tavily as the sole source; live testing found its LLM-synthesized answer occasionally yields the wrong price when a search result mentions more than one dollar figure — Spoonacular's structured field doesn't have this failure mode.)*
- Prices are cached per user as a **rate** (cents per 100g/100ml, or per unit-count), not a flat per-line total, and reused for 30 days — so the same cached rate still applies correctly even if the needed quantity differs the following week
- If neither source has data for an ingredient: display "$—" with a "Price unavailable — add manually" label; item still appears in the list and contributes $0 to the running total until overridden
- Manual price override available per item; corrections are stored in the same 30-day rate cache, keyed by ingredient + region, and reused in future weeks instead of re-querying for the same item — only re-queried if no stored correction exists or it's older than 30 days
- Weekly total cost displayed
- One-tap copy to clipboard
- **Known open gap (OQ9):** this weekly total is never reconciled against F2's `weekly_budget_usd` or F3's budget-aware filtering (which checks a different, recipe-level Spoonacular estimate during generation) — the two numbers can diverge, and this hasn't yet been tested across multiple real budgeted profiles. See OQ9.

#### F5 — Nutrition Dashboard (P0) · E4 Tracking & Progress — Free + Pro
- **Free:** daily calorie + macro view, actual vs. target, meal logging
- **Pro:** weekly summary analytics, 7-day trends, visual progress indicators
- Daily view: calories, protein, carbs, fat — actual vs. target
- Weekly summary view: 7-day totals and averages vs. weekly targets
- Meal logging: user marks meals as eaten (pre-populated from the meal plan)
- Off-plan logging: user can log a meal that wasn't in the plan (quick free-text entry with a rough macro estimate, or search against Spoonacular's ingredient database) — keeps the dashboard accurate when adherence breaks. Directly addresses the mid-week takeout / deviation pattern described in persona research (Priya) — without this, the dashboard goes stale the moment a user deviates from the plan
- Visual indicators: on track / slightly under / over target

#### F6 — Pantry Log (P1) · E2 Meal Planning — moved up from V2
- User manually inputs ingredients currently at home with a rough free-text quantity note, from Step 2 onward (7.1) or via the conversational assistant (F11) at any time
- **Structured quantity (built July 2026, optional):** alongside the free-text note, a user can also give a numeric amount + unit (e.g. "2, lb"). This is what unlocks quantitative grocery-list reduction below — purely additive, the free-text-only entry path is unchanged.
- **MVP:** entered items are passed to F3 as a soft preference (`includeIngredients`) so generation is biased toward using them. In F4's grocery list: if a matching entry has a comparable structured quantity, the needed amount is reduced by what's on hand (deterministic unit conversion, no LLM — this is arithmetic, not judgment, same principle as F4's pricing math); otherwise the ingredient is excluded from the list entirely, same as the original all-or-nothing design
- **V2:** automatic 7-day expiry unless refreshed, and barcode-scanned entry (F8) as a lower-friction alternative to typing
- Fully optional — skipping pantry entry leaves generation and the grocery list unchanged from the pre-pantry design

#### F7 — Meal Ratings (P1) · E5 Personalization (V2)
- Thumbs up / thumbs down on any meal after eating
- App avoids low-rated meals in future plan generations
- Used to personalise suggestions over time

#### F8 — Barcode Scanning for Pantry (P1) · E5 Personalization (V2)
- User points phone/laptop camera at a grocery item barcode
- Browser-side scanning via **ZXing-js** (no native mobile code, no app install)
- Barcode resolved via **Open Food Facts API** (free, no API key, User-Agent header only)
- Matched product and quantity auto-added to the pantry log (F6, MVP feature — this ticket only adds the barcode entry method, not the pantry log itself)
- Fallback: manual text entry if product not found in Open Food Facts
- Directly addresses Assumption A4 (pantry manual entry friction)

#### F9 — Recipe Cooking Videos (P2) · E2 Meal Planning
- Each meal card in the meal plan shows a "Watch how to cook this" link
- MVP: deep-links to `youtube.com/results?search_query=<meal+name>+recipe` — zero API calls, zero quota
- Post-MVP upgrade: in-app iframe embed via YouTube Data API v3 (free tier: 10,000 units/day, ~100 searches/day)
- Reduces drop-off when users encounter unfamiliar recipes

#### F10 — Calendar Export (P2) · E6 Discovery & Integrations
- One-tap "Export to Calendar" button on the weekly meal plan view
- Generates a `.ics` file (iCalendar format) via the **ics** npm package
- Each meal becomes a calendar event with recipe name, meal type, and macro summary in the description
- Compatible with Google Calendar, Apple Calendar, Outlook — no OAuth, no API quota
- Post-MVP option: direct Google Calendar API integration (1M requests/day free, requires OAuth)

#### F11 — Conversational Plan Assistant (P1) · E2 Meal Planning — new
- Persistent chat available across Steps 2–6 (Set Weekly Goal through Track) — not a one-shot Q&A widget
- Understands plain-language requests to: edit pantry contents, swap a specific meal, change a dietary constraint/allergy/dislike, or adjust the budget
- Every chat-driven change calls the same underlying action the UI buttons already call (pantry update, meal swap via F3, constraint edit via F2) — the assistant is a second interface onto existing state changes, not a separate mutation path
- Chat does not replace the form-based UI; both remain available for every action the assistant can do
- If a request is ambiguous or would violate a hard constraint (e.g. "swap to a recipe with peanuts" when peanut allergy is set), the assistant explains why and does not perform the action

---

### 7.4 Technology

MacroMap is built as an AI agent orchestrating four MCP data sources. Each layer is independently swappable as the product scales.

| Layer | MVP Implementation | Notes / Scale-up Path |
|-------|-------------------|-----------------------|
| Recipe + nutrition | **Spoonacular API** (paid from day one — free tier is development-only, not for commercial use). **Re-scoped (July 2026):** originally deliberately staged for development/an early cohort only, not KR1's full target — a recompute now suggests this tier likely *does* carry KR1's full 1,000-subscriber target after all (see the Objective section's capacity-dependency note and OQ6); kept here as a scale-up path regardless, since the recompute isn't yet production-confirmed. | Single API call returns recipe + per-ingredient nutrition data. `/recipes/complexSearch` accepts macro targets and dietary filters directly. Paid tier starts at $29/month (1,500 points/day). **Recomputed ceiling (July 2026, OQ6):** confirmed live cost formula `2.00 + 0.06 × resultsReturned` per query (nutrient-filtered, fully-detailed — the nutrient filter itself is a previously-uncounted flat +1.00pt on top of the base floor), combined with the real call pattern read directly from `web/`'s source: because all 3 meal types share one identical per-meal target, one shared query (`number=60`) serves the entire 21-slot plan, plus at most one more if weekly reconciliation triggers — **1–2 real calls per plan, not the many-queries model behind the old ~49/day figure.** Real ceiling: **~134/day conservative (every plan needs 2 full-result calls) to ~268/day typical (most need only 1)** — both well above what KR1/KR2 require. Not yet confirmed against a real production generation run. Revenue break-even at this tier: 4 Pro subscribers — recompute once the tier changes, since a higher tier raises the cost base. **Tier-upgrade trigger:** move to a higher Spoonacular tier or evaluate Edamam once measured daily generation volume reaches ~75% of the (now much higher) OQ6-confirmed ceiling. |
| Price estimates | **Spoonacular's ingredient `estimatedCost` field (primary, switched July 2026)** — no new vendor or cost, reuses the existing paid Spoonacular dependency; a structured number, not text to parse. **Tavily Search API (1,000 credits/month free, no credit card) as fallback only**, when Spoonacular has no cost data for an ingredient. | Tavily was originally the sole source (still preferred over Brave, which requires a credit card) but live testing found its LLM-synthesized answer can extract the wrong price from a multi-price search result — Spoonacular's structured field doesn't have that failure mode. Both are estimates only, not real-time retail prices. Upgrade path: Kroger API. |
| Pantry & constraints | Custom MCP (user-authored). Pantry contents now read at plan-generation time from MVP (F6, moved up from V2), not just used to filter the grocery list. | Barcode-scanned entry (F8) and automatic 7-day expiry remain V2. Synced receipt scanning (Post-MVP). |
| Barcode scanning | Open Food Facts API + ZXing-js (free, no key) | V2 — adds a lower-friction entry method to the pantry log (F6), which itself now ships in MVP. Native mobile barcode scanner post-MVP. |
| Recipe videos | YouTube deep-link (zero API, zero quota) | MVP. Upgrade to YouTube Data API v3 in-app embed (10,000 units/day free) in V2. |
| Calendar export | `.ics` file via `ics` npm package (no API, no OAuth) | MVP. Upgrade to Google Calendar API direct sync (OAuth, 1M req/day free) post-MVP. |

**Known cost constraint & staged capacity plan — updated conclusion (July 2026):** Spoonacular's $29/month paid tier was originally scoped purely for development and an early/small production cohort, on the assumption it couldn't carry KR1's full 1,000-subscriber target. A recompute grounded in the real shipped algorithm (see OQ6) — one shared query per plan instead of the originally-planned three, live-confirmed point costs — now puts the ceiling at roughly 134-268 plan-generations/day (~938-1,876/week), comfortably above the ~600/week KR2 needs for full KR1. Revenue break-even at this tier is still 4 Pro subscribers ($36/month). Cache results aggressively (see the two-cache split in F3/ai-agents.md Agent 2) — real-world cross-user cache hits could push effective capacity higher still. **Not yet production-confirmed** — this is a code-and-formula-grounded estimate, not a measured one. **Upgrade trigger:** track measured daily generation volume against the confirmed ceiling (OQ6); at ~75% of ceiling, move to a higher Spoonacular tier or evaluate Edamam — decide proactively, before capacity is actually exhausted, since an outage during a growth spike is the worst possible time to discover the ceiling.

**Application architecture (resolved):** Next.js (App Router, TypeScript) deployed on Vercel — one codebase serves both the frontend and the API routes/server actions that call Spoonacular and Tavily, so those keys are read from server-side environment variables and never reach the client bundle. Supabase (Postgres) provides the database and auth: user profiles, pantry/constraints, ratings, and both Agent 2 caches (the cross-user query-result cache and the per-user last-successful-plan cache — see ai-agents.md) live as Postgres tables; no separate cache service (e.g. Redis) is introduced at MVP scale, only if measured query volume later demands it. Supabase's built-in anonymous auth implements the guest→account flow from Section 7.1 Step 1/2 directly: a guest session starts as an anonymous Supabase user and is converted to a permanent account at Step 5 (Track), with no manual data-migration step required. Net new infrastructure cost pre-revenue: $0 beyond Spoonacular's $29/month (both Vercel and Supabase free tiers cover a pre-seed cohort).

---

### 7.5 Assumptions

These are things we believe to be true but have not yet validated with users:

| # | Assumption | Risk if wrong | How to validate |
|---|-----------|--------------|-----------------|
| A1 | Users will trust AI-generated macro calculations enough to follow the meal plan | High — if users don't trust the numbers, retention collapses. Elevated further by A6: some meals are now AI-composed/edited, not pure Spoonacular lookups. | 5–10 user interviews before launch |
| A2 | Spoonacular's recipe library (5,000+) is varied enough to sustain long-term use without repetition | Low — far larger library than original TheMealDB assumption | Monitor repeat meal rate; Spoonacular's `/recipes/complexSearch` supports `excludeIds` to force variety |
| A3 | Web search price estimates are accurate enough that users don't feel misled at checkout | Medium — budget users will notice | Track manual price correction rate |
| A4 | Users will log their pantry manually (without photo/receipt scanning) | Medium — if friction is too high, the pantry feature won't be used and F3's pantry-aware generation loses its input | Measure pantry log completion rate in first 2 weeks of MVP (see H6) |
| A5 | $9/month is below the willingness-to-pay threshold for Pro users | Medium — early signal positive (friends and forum outreach show interest in paying), but informal interest ≠ actual conversion. | Run 5–10 structured interviews to confirm price point before launch |
| A6 | AI-composed/edited recipes and snack add-ons — grounded in Spoonacular's per-ingredient nutrition data, never LLM-estimated — are macro-accurate and feel realistic enough that users don't rate them as lower quality than pure Spoonacular recipes | High — same trust surface as A1, extended to a new mechanism introduced by the pantry-first/AI-composition architecture change | Tag every meal by source (`spoonacular`/`ai-composed`/`ai-edited`/`snack-addon`) and compare acceptance/swap rates — see H8 |

---

## 8. Release

### MVP (Weeks 1–8)
The smallest version that proves the core loop: a user can go from goal → meal plan → grocery list in a single session.

**Includes:**
- Onboarding + TDEE calculation (F1)
- Preference & constraint input (F2)
- Meal plan generation — 3 meals/day, 7 days (F3)
- Grocery list with price estimates and manual override (F4)
- Basic nutrition dashboard — daily and weekly views (F5)
- Recipe video links — YouTube deep-link per meal (F9, MVP scope)
- Calendar export — .ics file download (F10, MVP scope)
- "Get Inspiration" button — deep-links to r/MealPrepSunday / r/EatCheapAndHealthy
- Pantry log — manual entry, generation-time use, grocery-list exclusion (F6, moved up from V2)
- Conversational plan assistant — chat-driven pantry/meal/constraint edits (F11, new)
- AI composition/edit fallback and snack/add-on gap-closer for macro fitting (F3, new — see Section 7.4)
- Free and Pro tier (no Coach tier)
- Web app only (no mobile)

**Does not include:**
- Meal ratings (F7) — added in V2
- Barcode scanning for pantry (F8) — added in V2; manual pantry entry (F6) ships in MVP regardless
- Pantry item auto-expiry (7 days) — added in V2 alongside barcode scanning
- Dietary style presets (keto, plant-based) — Post-MVP
- Grocery retailer API integration — Post-MVP
- Mobile app — Post-MVP
- Coach tier — Post-MVP

### V2 (Weeks 9–16)
Based on what MVP data shows. Expected additions:
- Meal ratings + personalisation (F7)
- Barcode scanning for pantry (F8) — Open Food Facts + ZXing-js
- Pantry item auto-expiry (7 days) unless refreshed
- Shopping list export (share / send to Notes)
- Mid-week macro tracking alerts
- In-app recipe video embeds (YouTube Data API v3 upgrade from F9 deep-links)

### V3 (Post-V2, based on traction)
- Dietary style presets (keto, high-carb, plant-based)
- Grocery retailer API for accurate pricing
- Receipt scanning for automatic pantry updates
- Mobile app (iOS first)
- Coach tier with client profiles

---

## Open Questions

| # | Question | Owner | Blocking? |
|---|---------|-------|-----------|
| ~~OQ1~~ | ~~Should we start with Spoonacular vs TheMealDB?~~ | Engineering | **Resolved: Spoonacular paid tier ($29/month) from day one. TheMealDB excluded — no nutrition data, only ~100 free recipes, not viable for MVP. Edamam evaluated and rejected — $38/month minimum for equivalent functionality.** |
| ~~OQ2~~ | ~~No recipe matches macro targets?~~ | Engineering + Design | **Resolved: Cascade fallback. (1) Query at ±10% tolerance. (2) No results → auto-widen to ±20%, silent retry. (3) Still no results → auto-widen to ±30%, silent retry. (3.5, added) Still no acceptable match, or pantry ingredients are being ignored → try the AI composition/edit fallback (F3) before falling through to step 5. (4) Match found outside ±10% → show meal with "Closest match — slightly outside your targets" label and macro delta. (5) No match at ±30% and the AI composition fallback also can't ground a valid recipe → friendly prompt identifying the blocking constraint (e.g. "Your protein target per meal is very high — try reducing by 10g") and let user adjust before retrying. Never show a blank state. Implemented via Spoonacular's `minProtein`/`maxProtein`/`minCalories`/`maxCalories` params widened on each retry.** |
| ~~OQ3~~ | ~~Weight units?~~ | Design | **Resolved: Accept both lbs and kg. User picks their unit on the onboarding form. App converts to kg immediately — all internal calculations (Mifflin-St Jeor, macro g/kg targets) run in metric.** |
| ~~OQ4~~ | ~~Multi-serving recipe scaling?~~ | Engineering | **Resolved: Auto-scale using Spoonacular's `servings` field. Formula: `grocery quantity = (recipe ingredient amount ÷ recipe servings) × times meal appears in week`. Spoonacular already returns macro data per serving — no custom nutrition scaling needed. Ingredient quantities from `extendedIngredients` are divided by `servings` to get per-meal amounts, then summed across the full plan for the grocery list. The same `extendedIngredients[].measures` payload (fetched once via `addRecipeInformation`/`fillIngredients`, see F3) is reused for F4's cross-recipe dedup and unit conversion — one fetch serves both needs, no second API call. **Extended for AI-composed recipes (F3):** every composed/edited recipe must declare an explicit `servings` count (default 1) and its own `extendedIngredients`-shaped ingredient list so this same formula applies unchanged — no separate scaling path for AI-touched meals. Live-confirmed July 2026 the *implementation* had drifted from this resolution — ingredients weren't being divided by `servings` (or scaled at all) in `rankCandidates`, inflating a real weekly grocery total to $1,085 before being fixed to match this formula exactly, landing at a plausible $140.78.** |
| ~~OQ5~~ | ~~Ingredient parsing layer?~~ | Engineering | **Resolved: Spoonacular returns pre-calculated nutrition per recipe — no custom parsing layer needed. Still holds for AI-composed recipes (F3): Claude proposes ingredients, but each one is resolved to a Spoonacular ingredient ID via `/food/ingredients/search` and its nutrition pulled via `/food/ingredients/{id}/information` — no freeform parsing or LLM-estimated macros introduced.** |
| OQ6 | Register Spoonacular paid API key and confirm point consumption per endpoint before engineering starts. Also measure actual cascade-trigger rate in early testing to validate real daily plan-generation capacity — this measurement must include the per-recipe cost of `addRecipeInformation`/`fillIngredients`, the candidate-ranking result count (F3), and OQ7's higher candidate count (7–8) for same-constraint meal-type groups, since those are all additive per meal query. **Live-verified July 2026 (via a real free-tier key, response headers — not desk research):** `complexSearch` costs **1.00 + 0.01 × number** as a floor (diet + `excludeIngredients` only, no nutrient filter) — confirmed by direct test. **Correction to the prior assumption:** adding the macro nutrient filter (`minProtein`/`maxProtein`/`minCalories`/`maxCalories`) is **not** included in that floor — it adds a further **flat +1.00 point per request**, confirmed by diffing quota-used before/after (1.01 → 2.01 total with filter added, same `number`). Since every real Recipe Agent call in this product uses the nutrient filter, the effective floor per query is **2.00 + 0.01 × number**, not 1.00 — the ~49/day ceiling below was computed assuming the lower floor and needs re-checking against this. `addRecipeInformation=true&fillIngredients=true` **confirmed exactly as previously assumed:** +0.05 points per recipe returned (0.025 each, verified via two live calls at `number=1` → 2.06 and `number=3` → 2.18, an exact +0.06 delta for +2 results = 0.03/result = the two 0.015... — precisely, cost formula confirmed as `2 + 0.06 × number` end-to-end for a nutrient-filtered, fully-detailed query). **Ingredients endpoints (new scope, now closed):** `/food/ingredients/search` and `/food/ingredients/{id}/information` each cost a flat **1.0 point per call** (confirmed live, no observed per-result increment at `number=1`) — cheap relative to a recipe query, good news for the F3 AI composition/snack fallback's per-ingredient cost. Both endpoints' responses include full macro data (Protein/Calories/Fat/Carbohydrates all confirmed present in a live `/information` response) — the grounding mechanism the composition fallback and snack add-ons depend on is technically validated to work, not just assumed. **Ceiling recomputed (July 2026), grounded in the actual `web/` source, not a fresh theoretical formula:** reading `orchestrate.ts`/`targets.ts`/`cascade.ts`/`reconciliation.ts`/`cacheKey.ts` directly (not just memory of the E2 build) confirms the real call pattern per plan generation: (a) `targets.ts`'s `perMealTarget` divides the daily target by 3 uniformly — breakfast/lunch/dinner get the *identical* bounds — so all 21 slots hash to the same `recipe_query_cache` key and `orchestrate.ts`'s in-flight de-dup collapses them to **exactly 1 real Spoonacular call** for the initial fetch (`CANDIDATES_PER_QUERY = 60`), not 21 and not the 3 meal-type-group queries the original F3/OQ7 design assumed; (b) exhaustion re-queries (claim.ts's rare path) reuse the *same* bounds/cache key as the initial fetch, so they hit the just-populated cache row and add **~0 real API cost**; (c) weekly reconciliation (`reconciliation.ts`) computes one `dominantDirection` and one `nudgedBounds` per generation, reused across all slack slots in that pass, so even retrying up to 3 slack slots costs **at most 1 additional real call**, only when the weekly ±5% band is actually missed. **Net: 1–2 real Spoonacular calls per plan generation (cold cache), not the many-queries model the old ~49/day ceiling assumed.** Combined with the confirmed cost formula (`2.00 + 0.06 × resultsReturned`, capped at `number=60`): a full-60-result call costs 5.6pts, so one plan costs **~5.6pts typical (1 call), ~11.2pts worst-case (2 calls, reconciliation triggered)** — before any cross-user cache reuse (same diet+macro-band tuple shared across users with similar goals), which would push real cost lower still. At the Cook tier's 1,500 points/day: **conservative ceiling (every plan needs 2 full-result calls, zero cache reuse) ≈ 134 plans/day (~938/week); typical ceiling (most plans need only 1 call) ≈ 268 plans/day (~1,876/week).** Both are well above KR2's ~600 generations/week needed for KR1's full 1,000-subscriber target — **this reverses the prior conclusion that the $29/month tier can't carry KR1** (see the Objective section's capacity-dependency note, updated accordingly), though it still needs live confirmation of (1) real reconciliation-trigger frequency and (2) real corpus result-count-at-p30 across actual user profiles (this session only confirmed the formula and call-count logic against source code — not a live 21-slot generation run). **Still open:** (1) confirm the above against a real production generation run, not just static code reading; (2) whether `includeIngredients` (pantry bias, new in this pivot) changes the query's cost — not tested this round, assume unchanged (it's a filter param, not a data-inclusion flag) until confirmed. Ongoing beyond initial measurement: this tier is intentionally scoped to development and an early/small production cohort (Section 7.4) — monitor measured daily generation volume against the confirmed ceiling on a recurring basis, and trigger the tier-upgrade/Edamam evaluation at ~75% of ceiling, proactively, before KR1's subscriber growth reaches it — though given the corrected ceiling, that trigger point is now much further out than previously thought. **Second, separate quota bug found and fixed (July 15 2026):** the recompute above only ever accounted for recipe-search cost — it did not know the fixed 9-ingredient snack/add-on pool (`snackComposition.ts`/`addon.ts`) was being live-re-fetched from Spoonacular's ingredient endpoints on *every single generation*, uncached, adding an uncounted ~18pt baseline (the whole pool) plus up to ~18pt/day more from reconciliation's add-on attempts. Live-confirmed: one real generation for a hard profile burned ~46.5 of a fresh 50-point key on this path alone, before failing outright. Root cause: these 9 ingredient names are fixed and non-user-specific (unlike the diet-dependent recipe corpus), so there was never a reason to re-query them live at all. Fixed by pinning their real, live-fetched macro *and* cost data in a static table (`staticIngredientMacros.ts`) — the identical generation that previously cost ~47 points now costs ~1. This was a pure implementation bug, not a flaw in the OQ6 recompute's call-count logic above, which still holds. **Third update, live recompute (2026-07-22) — the "1–2 calls/plan" model above is now confirmed stale, not just theoretically unconfirmed:** ran 15 real `orchestrateGeneration()` calls across a representative mix of profiles (not cherry-picked toward either extreme — see the Objective section's capacity-dependency note for the full weighting and numbers). Real cost averaged **at least ~34.2 points/generation** (a conservative floor; 5 of 15 profiles exhausted a full ~46–48pt test key before finishing, so the true average is higher, not lower), roughly 6x above the "~5.6pts typical" figure this recompute claimed. Real capacity at the $29/month tier's 1,500pts/day is **≈44 generations/day (~306/week) at best — about half the ~600/week KR2 needs, not comfortably above it.** Likely explanation (not fully root-caused this session): the per-meal-type-target fix from a later session (giving each meal type a realistic, non-uniform macro share instead of an even 1/3 split) broke the cache-collapse assumption in item (a) above — meal types no longer reliably share one cache key — and the post-generation plan-critic/repair pass (built the same day as this recompute, so not accounted for here) adds a real new Spoonacular query for every flagged slot on top of that. | Engineering | **Reopened — the "largely resolved" status below was based on a since-invalidated call-count model; real capacity is materially lower than KR2 needs and this needs a proper root-cause + a real production confirmation, not just this session's representative-sample measurement** |
| OQ8 | **New, surfaced by the pantry-first/AI-composition/F11 architecture change; scope widened July 15 2026:** capacity/cost planning above covers Spoonacular (OQ6) and Tavily + Haiku-tier price parsing (ai-agents.md Agent 3, "not yet budgeted"), but nothing yet measures or budgets the **Sonnet-tier Claude call volume** introduced by this change — now three distinct sources, not two: (a) the F3 AI composition/edit fallback, which fires per-slot whenever cascade fallback is exhausted, (b) the F11 conversational assistant, a persistent session across Steps 2–6 whose call volume scales with chat turns, not just plan generations, and (c) **new: the post-generation plan critique + repair pass (F3)**, which fires exactly once per generation whenever a key is configured, plus up to 5 additional real swap attempts if the critic flags problem slots. Needs: an estimate of how often (a) triggers per plan (depends on OQ6's ingredient-endpoint findings and real cascade-failure rate), a rough per-user chat-turn assumption for (b), and — since (c) is unconditional, not conditional like (a) — its cost is the easiest of the three to bound precisely once a key exists (1 critique call + 0-5 swap attempts, hard-capped). None of the three have run against the real Anthropic API yet: `ANTHROPIC_API_KEY` is still not configured in the working environment as of July 15 2026 — deferred by explicit direction, not an oversight. The deterministic logic surrounding all three (grounding, safety, portion bounds, the repair accept/reject decision) is built, tested, and in (c)'s case verified against real data by manually substituting for the LLM call — see F3's implementation notes above. Not blocking engineering start on E1/E2's existing deterministic path, but should be resolved before F11/the composition fallback/plan critique ship to real users. | Engineering | **No — resolve before F11/composition fallback/plan critique ship, not before engineering starts** |
| OQ9 | **New, surfaced while building/verifying F4's grocery pricing, July 2026:** F2's `weekly_budget_usd` and F3's budget-aware filtering check a recipe-level Spoonacular estimate (`pricePerServingCents`) during generation, but F4's real grocery-list total is priced independently (Spoonacular ingredient `estimatedCost`, Tavily fallback) — **the two numbers are never compared anywhere in the code**, confirmed by a direct cross-file trace (`ranking.ts`/`orchestrate.ts` for the budget check, `groceryData.ts`/`aggregate.ts` for the grocery total). A user could set a budget, get a plan the app calls "budget compliant," and see a grocery total meaningfully over or under that budget with no indication anything's off. Only one real profile has been checked end-to-end so far (and it hadn't actually set a budget) — next step is running several real budgeted profiles (tight budget, loose budget, no budget) through the full flow and measuring how far apart the two numbers land, then deciding whether to reconcile them (e.g. surface the real total against the stated budget on F4 with an over/under indicator) or leave them as intentionally-separate signals. | Design + Engineering | **No — F4 already ships useful value without this; resolve before leaning on "budget-aware" as a marketed guarantee** |
| ~~OQ7~~ | ~~Concurrency model for meal-plan generation?~~ | Engineering + Design | **Resolved: full parallel — all 21 Recipe Agent calls fire concurrently, with collision resolution done locally instead of by re-querying. Each slot's query returns a ranked candidate list per F3's candidate-selection rule, budget-compliant candidates ranked first by macro-deviation, with the single cheapest macro-matching candidate appended as the fallback-of-last-resort if none are budget-compliant — budget-awareness lives in the list's ordering, so stepping to a lower-ranked candidate never reintroduces a resolved budget miss. Once all 21 lists return, resolve variety collisions in a fixed slot order (Day 1 Breakfast → Day 7 Dinner): each slot greedily claims its top unclaimed candidate; a slot whose top candidate is already claimed steps down to its own next-ranked candidate — zero extra API cost in the common case, since the candidate is already fetched. Only if a slot's entire candidate list is exhausted does it re-query, capped the same way as the weekly-reconciliation pass. Note: the candidate-ranking "not used elsewhere this week" tie-break (F3) is a no-op during this initial parallel fetch, since nothing is claimed yet — actual variety enforcement happens entirely in this claim-resolution pass, not at query time. Accepted tradeoff: claim order is fixed, not globally optimal — a later slot may be bumped to a worse-ranked candidate even if its original top pick was objectively closer to target than the slot that claimed it first; consistent with the MVP's existing greedy approach elsewhere (budget cascade, F3). **Corrected (July 2026, against actual shipped code — see OQ6):** the "7-8 candidates for meal-type groups" plan above was the original theoretical design, not what was built. Since all 21 slots share one identical per-meal target (`targets.ts`), they all resolve from *one* shared query (`number=60`) rather than three meal-type-group queries — cheaper than either the 3–5 or 7–8 candidate-count model this paragraph originally proposed, since it's 1 real Spoonacular call instead of 3. OQ6 now has the recomputed real ceiling (~134–268 plans/day, not ~49/day) grounded directly in this shipped design. **Interaction with the F3 AI composition fallback:** that fallback is not part of this 21-way concurrent fetch — it only runs afterward, per-slot, for the specific slot(s) where cascade fallback + claim-resolution both fail to seat a Spoonacular candidate. It does not change this concurrency model, only what happens after it's exhausted for a given slot.** |

---

*MacroMap · PRD Draft v1 · MVP Scope · June 2026 · Confidential*
