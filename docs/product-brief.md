# MacroMap — Product Brief

> From weekly goal to grocery bag — without the spreadsheets.

**Stage:** Pre-seed concept | **Category:** Health & Nutrition · AI-powered | **Model:** Freemium SaaS | **Date:** June 2026

---

## 01 — The Problem

People who want to eat to a macro or budget target lose hours every week across multiple apps, websites, and personal notes to plan meals, source recipes, track macros, and estimate grocery costs. No single tool connects all four data points simultaneously.

> "I use a lot of websites and personal notes to track everything. It takes so much time just to make sure I'm hitting my protein and staying in budget."

The tools exist — but they don't talk to each other. No single product connects macro targets, recipe discovery, price awareness, and personal preferences in one continuous flow.

---

## 02 — Target Users

**Primary — Cutting & Bulking**
Gym-goers, athletes, and fitness-focused individuals tracking specific macro targets (protein/carb/fat/calories). Already disciplined and data-driven. Willing to pay for precision and time savings. Highly vocal in communities — strong word-of-mouth potential.

**Secondary — Budget-Conscious Healthy Eaters**
Students and busy professionals who want to eat well without overspending. Use the budget layer without necessarily needing macro precision. Benefit from the same product with budget as the primary constraint rather than macros.

---

## 03 — The Solution

The user states a weekly goal — **"hit 150g protein/day on a $90 budget"** — and MacroMap handles everything downstream: a planned week of meals, a consolidated shopping list, and a live nutrition dashboard.

```
Set Goal → Meal Plan → Grocery List → Track
```

| Step | Description |
|------|-------------|
| 01 Set Goal | Macro targets, weekly budget, preferences, allergies |
| 02 Meal Plan | AI-generated weekly plan matched to requirements |
| 03 Grocery List | Deduped shopping list with price estimates |
| 04 Track | Nutrition dashboard vs. weekly targets |

Users can optionally log what's already in their pantry, so the app avoids redundant purchases and builds meals around existing inventory.

---

## 04 — Differentiation

Existing tools — MyFitnessPal, Mealime, MacroFactor, Eat This Much — each solve one piece. The market gap isn't a missing tool; it's a missing connection between them.

> "Make this chicken stir-fry — you already have soy sauce, it hits your protein target, it fits your budget, and you've never rated it below 4 stars." No single app today can make that recommendation. MacroMap can, because it holds all four data points simultaneously.

This is not a consolidation play. It is a **contextual reasoning play**: the value is generated at the intersection of data sources that currently live in separate apps.

---

## 05 — Technical Architecture

Built as an AI agent orchestrating four distinct data sources via the Model Context Protocol (MCP), enabling clean separation and future substitution of any layer.

| MCP Layer | Description |
|-----------|-------------|
| **Recipe + Nutrition MCP** | **Spoonacular API** (paid, $29/month — 1,500 points/day). Single API call returns recipe + per-ingredient nutrition data together via `/recipes/complexSearch`. Accepts macro targets and dietary filters directly, eliminating any custom ingredient parsing layer. 5,000+ recipes. Evaluated against Edamam ($38/month minimum for equivalent functionality) — Spoonacular wins on value. |
| **Price MCP** | Web search MCP — **Tavily preferred over Brave** (1,000 free credits/month, no credit card required vs. Brave's credit card requirement). Both have the same grocery pricing limitations — estimates only, not real-time retail data. Manual override essential. Upgrade path: Kroger API. |
| **Pantry MCP** | Custom-authored MCP: pantry inventory, dietary constraints, dislikes, allergies, weekly budget. The personalization layer. |
| **Barcode MCP** | Open Food Facts API — free, no API key required. Browser camera scanning via ZXing-js. Lets users scan grocery items to instantly populate the pantry log, removing manual entry friction. |
| **Video Layer** | YouTube deep-link per meal (MVP: link to YouTube search results, no API needed). Post-MVP: in-app embed via YouTube Data API v3 free tier (10,000 units/day). |
| **Calendar Export** | `.ics` file generation via the `ics` npm package. One-tap export of the weekly meal plan to Google Calendar or Apple Calendar — no OAuth, no API quota. |

---

## 06 — Monetisation

Freemium subscription with feature-gated tiers. Free tier validates the core loop and drives top-of-funnel. Paid tiers gate features that cost real API usage (price lookups, pantry sync) and advanced analytics.

| Plan | Price | Target |
|------|-------|--------|
| **Free** | $0/month | Get started, validate the core loop |
| **Pro** | $9/month | Serious gym-goers cutting or bulking |
| **Coach** | $20/month | PTs and nutrition coaches |

**Free includes:** Weekly meal plan (3 meals/day, no budget constraint), allergy + dietary filtering (safety feature — never gated), basic macro tracking, grocery list without price estimates, recipe video links, calendar export.

**Pro includes:** Budget-aware meal planning, real-time price estimates (Tavily), pantry sync & inventory (V2), full nutrition dashboard with weekly analytics, shopping list export.

**Coach includes:** Multiple client profiles, client-facing meal plan sharing, advanced analytics, priority support.

---

## 07 — Risks & Mitigations

| Level | Risk | Mitigation |
|-------|------|------------|
| **Medium** | User research is informal only | Early demand signal validated: founder conversations with friends and forum posts show genuine interest and willingness to pay. Risk is not zero — informal interest doesn't guarantee conversion or retention. Mitigation: run 5–10 structured interviews before full build to validate macro-vs-budget priority, willingness to pay at $9/month, and which features matter most. |
| **Medium** | Spoonacular API cost dependency | Spoonacular is a paid dependency from day one ($29/month). Revenue break-even is 4 Pro subscribers. Risk: price changes or API deprecation. Mitigation: Edamam is a validated fallback ($38/month); MCP architecture makes the recipe layer swappable. |
| **Medium** | Price estimate accuracy | Web search prices (Tavily) are approximate. Mitigated by manual override; upgrade path is Kroger API for real-time retail prices. |
| **Medium** | Single point of failure on Spoonacular for plan generation | If the API is down or the daily quota is exhausted, serve the user's cached last-successful plan with a "temporarily unavailable" banner rather than a blank or error state — never a dead end. |
| **Low** | Search API rate limits | Free tiers cap daily queries. Gate price lookups behind Pro plan to align cost with revenue. |

---

## 08 — MVP Scope

**In MVP**
- Macro target input
- Weekly meal plan generation
- Deduped shopping list
- Web search price estimates + manual override
- Pantry & constraints MCP
- Basic nutrition dashboard
- Dietary preference & allergy filtering
- Recipe video links (YouTube deep-link per meal — no API required)
- Weekly meal plan export to calendar (.ics file download)
- "Get inspiration" deep-link to r/MealPrepSunday and r/EatCheapAndHealthy filtered by goal

**V2**
- Barcode scanning for pantry (Open Food Facts API + ZXing-js browser camera)
- In-app recipe video embeds (YouTube Data API v3 free tier)

**Post-MVP**
- Grocery retailer API integration (Kroger) for real-time pricing
- Receipt scanning for local price learning
- Coach tier with client profiles
- Mobile app
- Community recipe ratings
- B2B partnerships with gyms & coaches

---

## 09 — Open Questions

- ~~What is the final product name?~~ **Resolved: MacroMap.**
- ~~What is the geographic launch market?~~ **Resolved: United States.** Price estimates, recipe defaults, and regulatory considerations scoped to US market at launch.
- ~~Is there a B2B angle worth pursuing early?~~ **Resolved: Pure consumer for now.** Revisit after achieving meaningful consumer traction.
- ~~What does onboarding look like?~~ **Resolved: Hybrid onboarding.** User enters weight, height, age, activity level, and goal (cut / bulk / maintain). App calculates TDEE via Mifflin-St Jeor formula and suggests macro targets. User can accept or manually override. Available on free tier — no API cost, no reason to gate it.
- ~~What macro split does the app use?~~ **Resolved: Fixed defaults for MVP, user can nudge values.** No custom split UI — reduces complexity and decision fatigue. Dietary style presets (keto, high-carb, plant-based) are Post-MVP.

| Goal | Protein | Fat | Carbs |
|------|---------|-----|-------|
| Cut | 2.2g/kg bodyweight | 25% of calories | Remainder |
| Bulk | 1.8g/kg bodyweight | 25% of calories | Remainder |
| Maintain | 1.6g/kg bodyweight | 30% of calories | Remainder |

- ~~Which licensed recipe API — Spoonacular or Edamam?~~ **Resolved: Spoonacular at $29/month.** Edamam evaluated and rejected — requires two separate subscriptions ($9 recipe + $29 nutrition = $38/month minimum) for equivalent functionality. Spoonacular's single API covers both at lower cost.

---

*MacroMap · Product Brief Draft v1 · June 2026 · Confidential*
