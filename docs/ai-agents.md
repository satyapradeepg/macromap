# MacroMap — AI Agents

> How will your product use AI?

**Stage:** Pre-seed | **Date:** July 2026

---

## Overview

MacroMap is built as an **AI agent system** — a central orchestrator (Claude) coordinates a set of specialised MCP (Model Context Protocol) agents, each owning one data domain. The orchestrator reasons across all agents simultaneously to produce contextual recommendations that no single data source could generate alone.

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
 Recipe Agent   Price Agent   Pantry Agent
 (Spoonacular)   (Tavily)    (Custom MCP)
```

---

## Agent 1 — Orchestrator (Claude)

**Role:** The central reasoning layer. Receives the user's weekly goal and coordinates all downstream agents to produce the meal plan, grocery list, and nutrition summary.

**What it does:**
- Accepts user inputs: macro targets, budget, dietary preferences, allergies, pantry contents, prior meal ratings
- Decides which recipes to query (what constraints to pass to the Recipe Agent)
- Applies the cascade tolerance fallback (±10% → ±20% → ±30%) when no recipe matches
- Deduplicates and aggregates ingredients across 21 meals into a single grocery list
- Instructs the Price Agent to look up costs for each ingredient
- Excludes pantry items from the grocery list
- Generates the daily and weekly nutrition summary

**When it runs:** On demand — triggered when the user clicks "Generate my meal plan" or "↺ Swap meal"

**AI model:** Claude (Sonnet 4.6 for MVP; upgrade path to Opus for complex constraint satisfaction at scale)

**Why AI and not a rule-based system:** A rule-based system cannot simultaneously optimise across macro targets, budget, pantry inventory, allergens, dietary preferences, and past ratings — the constraint space is too combinatorial. Claude reasons across all dimensions in a single pass.

---

## Agent 2 — Recipe Agent (Spoonacular MCP)

**Role:** Surfaces recipes that satisfy the user's macro and dietary constraints in a single API call.

**What it does:**
- Receives from Orchestrator: target protein/carb/fat/calorie ranges, dietary flags (vegetarian, gluten-free, etc.), excluded allergens, excluded recipe IDs (previously rated low or recently shown)
- Queries Spoonacular `/recipes/complexSearch` with `minProtein`, `maxProtein`, `minCalories`, `maxCalories`, `diet`, `excludeIngredients`, `excludeIds`
- Returns: recipe name, ingredient list with quantities, per-serving nutrition data
- If zero results: widens tolerance range and retries (cascade fallback, up to 3 rounds); if a Pro budget constraint is still unmet after the macro cascade, drops budget filtering for that meal and selects the cheapest macro-matching result instead
- If Spoonacular is unreachable or the daily quota is exhausted: returns the cached last-successful plan for that user instead of erroring — Orchestrator surfaces a "using last week's plan" banner
- Caches results server-side to reduce API point consumption across similar queries, and to serve as the fallback source during an outage

**Data returned to Orchestrator:** Recipe name, `servings` count, `extendedIngredients` (name, amount, unit), per-serving macros (protein, carbs, fat, calories)

**API:** Spoonacular paid tier ($29/month, 1,500 points/day)

**Scale-up path:** Higher Spoonacular tier when daily generations exceed quota; Edamam as fallback vendor

---

## Agent 3 — Price Agent (Tavily MCP)

**Role:** Estimates the current US retail price for each grocery ingredient by location.

**What it does:**
- Receives from Orchestrator: ingredient name + quantity + user's US region (derived from zip code set during onboarding)
- Before querying Tavily: checks for a stored user price correction for this ingredient + region (reused if under 30 days old) — skips the Tavily call entirely if a fresh correction exists
- Queries Tavily Search API with a structured query: `"<ingredient> price per <unit> <region> grocery store 2026"`
- Parses the returned web results to extract a price estimate
- Returns: estimated price per unit, confidence level (high / approximate)
- If no result found: returns `null` — Orchestrator displays "$—" with "add manually" prompt
- Any manual correction the user makes in F4 is written back here, keyed by ingredient + region, for reuse in future weeks

**Data returned to Orchestrator:** Price estimate (USD), confidence flag

**API:** Tavily Search API (1,000 free credits/month)

**Limitation:** Returns web-scraped estimates, not real-time retail data. Manual override always available.

**Scale-up path:** Kroger Developer API for real-time shelf prices once Tavily estimate accuracy drops below threshold

---

## Agent 4 — Pantry Agent (Custom MCP)

**Role:** The personalisation layer. Owns all user-specific persistent state: pantry inventory, dietary constraints, allergen flags, dislikes, weekly budget, and meal ratings.

**MVP scope note:** dietary constraints, allergen flags, dislikes, and weekly budget are active from day one (F2) — the Orchestrator reads these on every plan generation. Pantry *inventory* (item tracking, exclusion from grocery list) and meal ratings are V2-only (F6, F7); see PRD F3. This agent stores both categories of data, but only the constraint half is read during MVP plan generation.

**What it does:**
- Stores and retrieves: pantry items (name, quantity, expiry date), dietary restrictions, allergy flags, disliked ingredients, weekly grocery budget, meal rating history (thumbs up/down by recipe ID)
- Provides Orchestrator with: current pantry contents (to exclude from grocery list), low-rated recipe IDs (to add to `excludeIds`), user's allergen list, budget ceiling
- Updates after each shop: marks pantry items as added from grocery list
- Expires pantry items after 7 days unless refreshed

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
1. User completes onboarding (F1, F2)
   └── Pantry Agent stores constraints: goal, macros, allergies, preferences, budget
       (pantry *inventory* itself is not populated yet — V2 only, see Agent 4 MVP scope note)

2. User taps "Generate meal plan"
   └── Orchestrator reads Pantry Agent's stored constraints
   └── Orchestrator calls Recipe Agent × 21 (3 meals × 7 days)
       ├── Recipe Agent queries Spoonacular with macro + dietary constraints
       ├── If no macro match → cascade tolerance widening (up to 3 rounds, ±10%→±20%→±30%)
       ├── If Pro budget still unmet after macro cascade → drop budget filter for that meal,
       │     select cheapest macro-matching option, label with budget delta
       ├── If Spoonacular is unavailable/quota-exhausted → serve cached last-successful
       │     plan with a banner instead of failing
       └── Returns 21 recipes with per-serving nutrition data

3. Orchestrator aggregates grocery list
   └── Scales ingredient quantities: (amount ÷ servings) × frequency
   └── Deduplicates across all 21 meals
   └── V2 only: removes any items in Pantry Agent inventory (MVP has no pantry inventory
         to check against — see PRD F3)
   └── Calls Price Agent for each grocery item
       ├── Checks for a stored user price correction first (reused across weeks)
       └── If none stored → Price Agent queries Tavily → returns estimate or null

4. Orchestrator renders outputs
   ├── Meal plan (F3): 7-day view with per-meal macros
   ├── Grocery list (F4): deduped items with prices
   └── Nutrition dashboard (F5): daily/weekly vs. targets

5. User taps "↺ Swap meal"
   └── Orchestrator calls Recipe Agent for one slot
       ├── Excludes the rejected recipe ID
       ├── Applies the same cascade fallback as initial generation
       ├── If cascade also fails → shows the blocking-constraint prompt scoped to that
       │     slot, never a dead end
       ├── Returns a new recipe for that slot only
       └── Updates grocery list and nutrition totals

6. User logs an off-plan meal (F5)
   └── Free-text or ingredient-search entry, macro-estimated and added to daily/weekly
         totals — keeps the dashboard accurate when the user deviates from the plan

7. User taps "Export to Calendar"
   └── Calendar Export Agent generates .ics file → downloads

8. Week 2+ (loop)
   └── Orchestrator pre-fills same goal from Pantry Agent
   └── Low-rated recipes (F7, V2) added to excludeIds
   └── New plan generated with fresh Spoonacular query
```

---

## AI vs. Rule-Based: Why This Needs AI

| Decision | Rule-based? | Why AI wins |
|---|---|---|
| Match 21 recipes to macro targets | Partial (filter) | Optimising across macro tolerance + variety + allergens + pantry + budget simultaneously is combinatorial — AI handles the tradeoffs |
| Cascade tolerance fallback | Yes (logic) | Simple rules work here — implemented as structured retry logic, not AI |
| Ingredient deduplication | Yes (logic) | Pure aggregation — no AI needed |
| Price parsing from Tavily results | No | Unstructured web text requires NLP to extract a price reliably |
| Serving-size scaling | Yes (formula) | `(amount ÷ servings) × frequency` — deterministic |
| Grocery list generation | Yes (aggregation) | Deterministic once recipes are selected |

**Bottom line:** AI is used where human-like reasoning across multiple constraints is required (recipe selection, price extraction). Deterministic logic handles everything else.

---

*MacroMap · AI Agents v1 · July 2026*
