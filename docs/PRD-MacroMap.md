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
Existing tools solve one piece each. MyFitnessPal tracks macros. Mealime suggests recipes. Cronometer measures nutrients. None connect all four data points — recipe + macros + price + personal preferences — into a single planning flow.

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

**Capacity dependency:** KR1's 1,000-subscriber target is not sized to run on the initial $29/month Spoonacular tier — see Section 7.3's staged capacity plan. At KR2's 60% weekly generation rate, 1,000 Pro subscribers alone need ~600 generations/week, well above that tier's ~343/week ceiling. The Spoonacular tier is scoped for development and an early/small production cohort by design; hitting KR1 requires proactively executing the tier-upgrade trigger (Section 7.3 / OQ6) well before growth reaches it, not reacting after capacity runs out.

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

Competitors solve one dimension. MacroMap solves the intersection:

> "Make this chicken stir-fry — you already have soy sauce, it hits your protein target, it fits your budget, and you've never rated it below 4 stars."

No single tool today can make that recommendation. MacroMap can, because it holds all four data points simultaneously.

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

**Account creation — resolved timing:** guests can complete the full loop (onboarding → plan → grocery list, Steps 1–4) with no account. The signup wall appears at Step 5 (Track) — saving progress, viewing history, or returning to a plan across sessions requires an account. This removes friction before the user has seen the product's value, maximizing onboarding completion (KR4).

**Step 3 — Generate Meal Plan**
App generates 3 meals per day for 7 days. Each meal is matched to:
- The user's macro targets (protein, carbs, fat, calories)
- Their dietary preferences and allergies
- Their budget (if set)
- **V2 only:** pantry inventory (avoids suggesting ingredients they already have)

User can swap individual meals they don't like.

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
| **E2 — Meal Planning** | F3, F9 | MVP | AI-generated weekly plan, macro-matched recipes, recipe video links |
| **E3 — Grocery Management** | F4 | MVP | Deduped shopping list, price estimates, manual overrides, calendar export |
| **E4 — Tracking & Progress** | F5 | MVP | Daily and weekly nutrition dashboard, meal logging |
| **E5 — Pantry & Personalization** | F6, F7, F8 | V2 | Pantry log, barcode scanning, meal ratings — closes the weekly loop |
| **E6 — Discovery & Integrations** | F10, Reddit deep-link | MVP | Calendar export, community inspiration links |

**MVP critical path:** E1 → E2 → E3 → E4 (in that order — each epic depends on the previous)
**V2 additions:** E5 ships as a self-contained unit after MVP data validates pantry value

---

### 7.3 Key Features

#### F1 — TDEE Calculator & Macro Onboarding (P0) · E1 Onboarding & Goal Setting
- Inputs: weight (lbs **or** kg — user selects unit, app converts to kg immediately for all calculations), height (ft/in **or** cm — same unit-toggle pattern as weight, converts to cm immediately), age, activity level (sedentary / lightly active / active / very active), goal (cut / bulk / maintain)
- All internal calculations use kg/cm — Mifflin-St Jeor formula and macro targets (g/kg bodyweight) both operate in metric
- Formula: Mifflin-St Jeor, activity multiplier applied to BMR:

| Activity level | Multiplier |
|---|---|
| Sedentary | 1.2 |
| Lightly active | 1.375 |
| Active | 1.55 |
| Very active | 1.725 |

- Input validation: age 13–100, weight 30–300kg, height 100–250cm — out-of-range values show an inline error and block submission
- Output: suggested daily calorie target + macro split (protein, fat, carbs)
- Default macro splits by goal:

| Goal | Protein | Fat | Carbs |
|------|---------|-----|-------|
| Cut | 2.2g/kg bodyweight | 25% of calories | Remainder |
| Bulk | 1.8g/kg bodyweight | 25% of calories | Remainder |
| Maintain | 1.6g/kg bodyweight | 30% of calories | Remainder |

- User can nudge any value manually after seeing the suggestion
- Guest session (no account yet): onboarding inputs and generated plan persist in browser localStorage. Account creation is only required at Step 5 (Track) to save/sync across sessions — see Section 7.1 Step 1/2 for the resolved account-timing decision.

#### F2 — Preference & Constraint Input (P0) · E1 Onboarding & Goal Setting
- **Tier: Free** — allergy and dietary filtering is a safety feature, never gated
- Dietary restrictions: vegetarian, vegan, gluten-free, dairy-free, halal, kosher
- Allergy flags: nuts, shellfish, eggs, soy (free text + common presets)
- Dislikes: free text (e.g. "no Brussels sprouts")
- Weekly grocery budget: optional, numeric input in USD, visible on both tiers
  - **Pro:** entering a budget activates budget-aware filtering in F3
  - **Free:** budget field shown with a "Pro" lock badge and tooltip ("See if your plan fits — upgrade to filter recipes by budget"); if the generated plan's actual cost exceeds the entered budget, F4 shows an inline banner ("This week's plan is $X over your budget — upgrade to Pro to filter recipes that fit") rather than silently ignoring the input
- **Zip code (US):** collected during onboarding, visible on both tiers. Used to derive the region passed to the Price Agent (Tavily) for F4's price estimates — see ai-agents.md Agent 3. Not required to complete onboarding on Free tier (no price estimates shown, F4); prompted before first Pro-tier plan generation if not already provided

#### F3 — Meal Plan Generation (P0) · E2 Meal Planning — Free + Pro
- **Free:** 3 meals/day, 7 days, macro-matched, allergy/dietary filtered, no budget constraint applied
- **Pro:** all of the above + budget-aware filtering (recipes chosen to keep weekly grocery total within budget)
- 3 meals per day × 7 days = 21 meals per week
- Recipes sourced via **Spoonacular API** (`/recipes/complexSearch`) — queries by macro targets, dietary filters, and excluded allergens in a single call; returns recipe + per-ingredient nutrition data together
- Query includes `addRecipeInformation=true` and `fillIngredients=true` so each returned recipe's `extendedIngredients` array is fully populated with a `measures` object (`us` and `metric` amount + unit) in the same call — this same payload feeds both the OQ4 serving-scaling math and the F4 grocery-dedup/unit-conversion step below, so no separate ingredient-conversion API call is ever needed. These two flags each add 0.025 points per recipe returned (confirmed against Spoonacular's points pricing) — keep the candidate-ranking result count (`number` param, see candidate-selection bullet above) at 3–5 for slots with a unique constraint tuple, but 7–8 for meal-type groups where all 7 days share an identical tuple (breakfast/lunch/dinner) to give OQ7's parallel claim-resolution enough headroom to avoid re-querying; fold the real per-query point cost into OQ6's capacity measurement rather than assuming a fixed ceiling already accounts for it
- Spoonacular returns macro data **per serving** — this is what is displayed on each meal card in the plan view, so users see accurate per-meal macros before committing to the grocery list
- Each recipe must fit within the user's macro targets (±10% tolerance per meal) — cascade fallback per OQ2
- **Candidate selection when multiple recipes match a tier:** deterministic, not AI-judged. Score = weighted deviation from the per-meal target — `|protein_actual − protein_target| / protein_target × 2 + |calories_actual − calories_target| / calories_target` (protein weighted 2× per the macro-split priority in F1) — lowest score wins, with budget-compliant candidates ranked first (Pro only) and the cheapest macro-matching candidate appended as fallback-of-last-resort only if none are budget-compliant. Ties broken by: cheapest (Pro only) → highest Spoonacular `aggregateLikes`. Variety ("not used elsewhere this week") is enforced separately, in the cross-slot claim-resolution pass (OQ7) — not as a ranking tie-break here, since all 21 slots resolve concurrently and no slot knows what others picked at ranking time. See Agent 2 in ai-agents.md.
- Filters out any recipe containing allergens or disliked ingredients (passed as `excludeIngredients` param) — this exclusion is a hard filter applied at every cascade tier, never widened or relaxed
- **Budget cascade fallback (Pro only):** if no recipe satisfies both macro tolerance and budget at any OQ2 tier, drop budget filtering for that meal and select the cheapest macro-matching option instead; label the meal "Closest to your budget — $X over" with the delta shown. Never blocks plan generation on budget alone.
- **Weekly reconciliation pass:** per-meal tolerance (±10–30%) does not guarantee the weekly aggregate lands on target, so after all 21 meals are selected, sum actual protein/calories/carbs/fat and compare against a tighter ±5% weekly band. If outside band, re-query up to 3 meals with the most slack (furthest from their own per-meal target, in the direction that would close the weekly gap), with bounds nudged toward the deficit. Capped at 3 extra queries per plan to protect API quota (see Section 7.3 capacity note). If still outside ±5% after the cap, the weekly dashboard (F5) shows the actual delta rather than implying an exact match.
- **MVP:** pantry-aware planning is not active — pantry log (F6) ships in V2
- User can tap "swap meal" on any individual meal to get an alternative (triggers a new Spoonacular query with the same constraints, excluding the rejected recipe). If cascade fallback also fails to find a replacement for that single slot, show the same "no match — here's the blocking constraint" prompt used at OQ2's final tier, scoped to just that meal — never a dead end
- **Spoonacular outage/quota fallback:** if the API errors or the daily point quota is exhausted, serve the user's last successfully generated plan from cache with a banner: "Using last week's plan — live generation is temporarily unavailable, try again shortly." Never show a blank state or unhandled error
- Two distinct server-side caches (see ai-agents.md Agent 2 for detail): (1) a cross-user query-result cache keyed on shared constraints (macro range, diet, excluded ingredients — deliberately excluding the per-user `excludeIds` list, which would fragment hit rate to near-zero) to minimise API point consumption, and (2) a per-user last-successful-plan cache, used only as the outage/quota-exhaustion fallback above — not the same mechanism

#### F4 — Grocery List (P0) · E3 Grocery Management — Free + Pro
- **Free:** deduped grocery list with quantities, no price estimates shown
- **Pro:** price estimates per ingredient (Tavily), weekly total cost, manual price override
- Auto-generated from the weekly meal plan
- **Dedup key:** ingredient `id` from Spoonacular's `extendedIngredients` (fallback: normalized/descriptor-stripped name if `id` is missing) — never the raw ingredient display string. Raw-string matching fails on real recipe text (e.g. "1 lb boneless skinless chicken breast" vs. "16 oz raw chicken" vs. "2 cups chopped chicken breast" would be treated as three separate items); Spoonacular's canonical `id` is what makes these the same grocery-list line.
- **Unit reconciliation:** convert matched entries to a common unit using the `measures.metric.amount`/`unitShort` already returned in the same complexSearch call (see F3's `addRecipeInformation`/`fillIngredients` note) — sum locally, no extra API call. If `metric.unitShort` still doesn't match across matched entries for the same `id` (or `measures` is missing), don't force a merge — list as a separate line under that ingredient with a "combine manually" prompt, same fallback pattern as the price-unavailable case below. Volume-based measures (e.g. "chopped," "cups") converted to weight are Spoonacular's own density estimate, not exact.
- Ingredients deduplicated and quantities summed across all recipes using the key and unit rules above
- Price estimate per ingredient via **Tavily Search API** (1,000 free credits/month, no credit card required), by US region
- If Tavily returns no result for an ingredient: display "$—" with a "Price unavailable — add manually" label; item still appears in the list and contributes $0 to the running total until overridden
- Manual price override available per item; corrections are stored per user, keyed by ingredient + region, and reused in future weeks instead of re-querying Tavily for the same item — only re-queried if no stored correction exists or it's older than 30 days
- Weekly total cost displayed
- One-tap copy to clipboard

#### F5 — Nutrition Dashboard (P0) · E4 Tracking & Progress — Free + Pro
- **Free:** daily calorie + macro view, actual vs. target, meal logging
- **Pro:** weekly summary analytics, 7-day trends, visual progress indicators
- Daily view: calories, protein, carbs, fat — actual vs. target
- Weekly summary view: 7-day totals and averages vs. weekly targets
- Meal logging: user marks meals as eaten (pre-populated from the meal plan)
- Off-plan logging: user can log a meal that wasn't in the plan (quick free-text entry with a rough macro estimate, or search against Spoonacular's ingredient database) — keeps the dashboard accurate when adherence breaks. Directly addresses the mid-week takeout / deviation pattern described in persona research (Priya) — without this, the dashboard goes stale the moment a user deviates from the plan
- Visual indicators: on track / slightly under / over target

#### F6 — Pantry Log (P1) · E5 Pantry & Personalization
- User manually inputs ingredients currently at home with rough quantities
- App excludes pantry items from the grocery list
- Pantry updated after each shop (items added from grocery list)
- Items expire from pantry after 7 days unless refreshed

#### F7 — Meal Ratings (P1) · E5 Pantry & Personalization
- Thumbs up / thumbs down on any meal after eating
- App avoids low-rated meals in future plan generations
- Used to personalise suggestions over time

#### F8 — Barcode Scanning for Pantry (P1) · E5 Pantry & Personalization
- User points phone/laptop camera at a grocery item barcode
- Browser-side scanning via **ZXing-js** (no native mobile code, no app install)
- Barcode resolved via **Open Food Facts API** (free, no API key, User-Agent header only)
- Matched product and quantity auto-added to the pantry log (F6)
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

---

### 7.3 Technology

MacroMap is built as an AI agent orchestrating four MCP data sources. Each layer is independently swappable as the product scales.

| Layer | MVP Implementation | Notes / Scale-up Path |
|-------|-------------------|-----------------------|
| Recipe + nutrition | **Spoonacular API** (paid from day one — free tier is development-only, not for commercial use). **Deliberately staged:** this tier is scoped for development and an early/small production cohort only — it is not sized to carry KR1's full 1,000-subscriber target (see the Objective section's capacity dependency note). | Single API call returns recipe + per-ingredient nutrition data. `/recipes/complexSearch` accepts macro targets and dietary filters directly. Paid tier starts at $29/month (1,500 points/day; ~49 full plan generations/day is a current best-case **ceiling** — accounts for the flat nutrient-filter charge, `addRecipeInformation`/`fillIngredients` per-recipe cost, and OQ7's 7–8-candidate fetch for same-constraint meal-type groups; cascade fallback (OQ2) and weekly reconciliation can add further queries on top, so real sustainable capacity may be lower until measured). Revenue break-even at this tier: 4 Pro subscribers — recompute once the tier changes, since a higher tier raises the cost base. **Tier-upgrade trigger:** move to a higher Spoonacular tier or evaluate Edamam once measured daily generation volume reaches ~75% of the OQ6-confirmed ceiling (~37/day against the current ~49/day estimate) — monitor proactively so the upgrade happens ahead of hitting the wall, not after. |
| Price estimates | Tavily Search API (1,000 credits/month free, no credit card) | Preferred over Brave (Brave requires credit card). Returns web search results — estimates only, not real-time retail prices. Upgrade: Kroger API. |
| Pantry & constraints | Custom MCP (user-authored) | Synced receipt scanning (Post-MVP) |
| Barcode scanning | Open Food Facts API + ZXing-js (free, no key) | V2, alongside pantry log. Native mobile barcode scanner post-MVP. |
| Recipe videos | YouTube deep-link (zero API, zero quota) | MVP. Upgrade to YouTube Data API v3 in-app embed (10,000 units/day free) in V2. |
| Calendar export | `.ics` file via `ics` npm package (no API, no OAuth) | MVP. Upgrade to Google Calendar API direct sync (OAuth, 1M req/day free) post-MVP. |

**Known cost constraint & staged capacity plan:** Spoonacular's $29/month paid tier is a deliberate, intentionally-scoped operating cost for development and an early/small production cohort — not an attempt to carry KR1's full 1,000-subscriber target. Revenue break-even at this tier is 4 Pro subscribers ($36/month); this break-even resets once the tier changes. Monitor API point consumption; 1,500 points/day supports up to roughly ~49 full plan generations once the nutrient-filter charge, `addRecipeInformation`/`fillIngredients`, and OQ7's larger candidate fetch for same-constraint meal groups are all accounted for — treat this as a ceiling, not a target, since cascade retries and weekly reconciliation reduce it further in practice. Cache results aggressively (see the two-cache split in F3/ai-agents.md Agent 2) to stay within quota during early growth. **Upgrade trigger:** track measured daily generation volume against the confirmed ceiling (OQ6); at ~75% of ceiling, move to a higher Spoonacular tier or evaluate Edamam — decide proactively, before capacity is actually exhausted, since an outage during a growth spike is the worst possible time to discover the ceiling.

**Application architecture (resolved):** Next.js (App Router, TypeScript) deployed on Vercel — one codebase serves both the frontend and the API routes/server actions that call Spoonacular and Tavily, so those keys are read from server-side environment variables and never reach the client bundle. Supabase (Postgres) provides the database and auth: user profiles, pantry/constraints, ratings, and both Agent 2 caches (the cross-user query-result cache and the per-user last-successful-plan cache — see ai-agents.md) live as Postgres tables; no separate cache service (e.g. Redis) is introduced at MVP scale, only if measured query volume later demands it. Supabase's built-in anonymous auth implements the guest→account flow from Section 7.1 Step 1/2 directly: a guest session starts as an anonymous Supabase user and is converted to a permanent account at Step 5 (Track), with no manual data-migration step required. Net new infrastructure cost pre-revenue: $0 beyond Spoonacular's $29/month (both Vercel and Supabase free tiers cover a pre-seed cohort).

---

### 7.4 Assumptions

These are things we believe to be true but have not yet validated with users:

| # | Assumption | Risk if wrong | How to validate |
|---|-----------|--------------|-----------------|
| A1 | Users will trust AI-generated macro calculations enough to follow the meal plan | High — if users don't trust the numbers, retention collapses | 5–10 user interviews before launch |
| A2 | Spoonacular's recipe library (5,000+) is varied enough to sustain long-term use without repetition | Low — far larger library than original TheMealDB assumption | Monitor repeat meal rate; Spoonacular's `/recipes/complexSearch` supports `excludeIds` to force variety |
| A3 | Web search price estimates are accurate enough that users don't feel misled at checkout | Medium — budget users will notice | Track manual price correction rate |
| A4 | Users will log their pantry manually (without photo/receipt scanning) | Medium — if friction is too high, pantry feature won't be used | Measure pantry log completion rate in first 2 weeks |
| A5 | $9/month is below the willingness-to-pay threshold for Pro users | Medium — early signal positive (friends and forum outreach show interest in paying), but informal interest ≠ actual conversion. | Run 5–10 structured interviews to confirm price point before launch |

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
- Free and Pro tier (no Coach tier)
- Web app only (no mobile)

**Does not include:**
- Pantry log (F6) — added in V2
- Meal ratings (F7) — added in V2
- Barcode scanning (F8) — added in V2 alongside pantry log
- Dietary style presets (keto, plant-based) — Post-MVP
- Grocery retailer API integration — Post-MVP
- Mobile app — Post-MVP
- Coach tier — Post-MVP

### V2 (Weeks 9–16)
Based on what MVP data shows. Expected additions:
- Pantry log (F6)
- Meal ratings + personalisation (F7)
- Barcode scanning for pantry (F8) — Open Food Facts + ZXing-js
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
| ~~OQ2~~ | ~~No recipe matches macro targets?~~ | Engineering + Design | **Resolved: Cascade fallback. (1) Query at ±10% tolerance. (2) No results → auto-widen to ±20%, silent retry. (3) Still no results → auto-widen to ±30%, silent retry. (4) Match found outside ±10% → show meal with "Closest match — slightly outside your targets" label and macro delta. (5) No match at ±30% → friendly prompt identifying the blocking constraint (e.g. "Your protein target per meal is very high — try reducing by 10g") and let user adjust before retrying. Never show a blank state. Implemented via Spoonacular's `minProtein`/`maxProtein`/`minCalories`/`maxCalories` params widened on each retry.** |
| ~~OQ3~~ | ~~Weight units?~~ | Design | **Resolved: Accept both lbs and kg. User picks their unit on the onboarding form. App converts to kg immediately — all internal calculations (Mifflin-St Jeor, macro g/kg targets) run in metric.** |
| ~~OQ4~~ | ~~Multi-serving recipe scaling?~~ | Engineering | **Resolved: Auto-scale using Spoonacular's `servings` field. Formula: `grocery quantity = (recipe ingredient amount ÷ recipe servings) × times meal appears in week`. Spoonacular already returns macro data per serving — no custom nutrition scaling needed. Ingredient quantities from `extendedIngredients` are divided by `servings` to get per-meal amounts, then summed across the full plan for the grocery list. The same `extendedIngredients[].measures` payload (fetched once via `addRecipeInformation`/`fillIngredients`, see F3) is reused for F4's cross-recipe dedup and unit conversion — one fetch serves both needs, no second API call.** |
| ~~OQ5~~ | ~~Ingredient parsing layer?~~ | Engineering | **Resolved: Spoonacular returns pre-calculated nutrition per recipe — no custom parsing layer needed.** |
| OQ6 | Register Spoonacular paid API key and confirm point consumption per endpoint before engineering starts. Also measure actual cascade-trigger rate in early testing to validate real daily plan-generation capacity — this measurement must include the per-recipe cost of `addRecipeInformation`/`fillIngredients` (0.025 pts each, confirmed), the candidate-ranking result count (F3), and OQ7's higher candidate count (7–8) for same-constraint meal-type groups, since those are all additive per meal query. Treat ~49/day as the current best-case ceiling (down from the earlier ~71/day estimate) pending this measurement — not a guarantee either way. Ongoing beyond initial measurement: this tier is intentionally scoped to development and an early/small production cohort (Section 7.3) — monitor measured daily generation volume against the confirmed ceiling on a recurring basis, and trigger the tier-upgrade/Edamam evaluation at ~75% of ceiling, proactively, before KR1's subscriber growth reaches it. | Engineering | **Yes — immediate action required** |
| ~~OQ7~~ | ~~Concurrency model for meal-plan generation?~~ | Engineering + Design | **Resolved: full parallel — all 21 Recipe Agent calls fire concurrently, with collision resolution done locally instead of by re-querying. Each slot's query returns a ranked candidate list per F3's candidate-selection rule, budget-compliant candidates ranked first by macro-deviation, with the single cheapest macro-matching candidate appended as the fallback-of-last-resort if none are budget-compliant — budget-awareness lives in the list's ordering, so stepping to a lower-ranked candidate never reintroduces a resolved budget miss. Once all 21 lists return, resolve variety collisions in a fixed slot order (Day 1 Breakfast → Day 7 Dinner): each slot greedily claims its top unclaimed candidate; a slot whose top candidate is already claimed steps down to its own next-ranked candidate — zero extra API cost in the common case, since the candidate is already fetched. Only if a slot's entire candidate list is exhausted does it re-query, capped the same way as the weekly-reconciliation pass. Note: the candidate-ranking "not used elsewhere this week" tie-break (F3) is a no-op during this initial parallel fetch, since nothing is claimed yet — actual variety enforcement happens entirely in this claim-resolution pass, not at query time. Accepted tradeoff: claim order is fixed, not globally optimal — a later slot may be bumped to a worse-ranked candidate even if its original top pick was objectively closer to target than the slot that claimed it first; consistent with the MVP's existing greedy approach elsewhere (budget cascade, F3). Cost consequence: resolving collisions locally instead of re-querying requires more candidates per query for meal-type groups where 7 slots share an identical constraint tuple (breakfast/lunch/dinner all divide the weekly target the same way) — recommend 7–8 candidates for those groups instead of the general 3–5 (F3). This raises per-plan point cost and lowers the realistic daily capacity ceiling from the prior ~67–71/day estimate to roughly ~49/day — an estimate, not final; must be confirmed against real usage in OQ6.** |

---

*MacroMap · PRD Draft v1 · MVP Scope · June 2026 · Confidential*
