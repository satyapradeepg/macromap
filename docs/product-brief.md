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
| 01 Set Goal | Macro targets, weekly budget, preferences, allergies, optional pantry contents |
| 02 Meal Plan | AI-generated weekly plan matched to requirements — pantry-aware from the start, with a conversational assistant to adjust it in plain language |
| 03 Grocery List | Deduped shopping list with price estimates |
| 04 Track | Nutrition dashboard vs. weekly targets |

Users can optionally log what's already in their pantry — active from day one, not a later add-on — so the app builds meals around existing inventory and avoids redundant purchases. A persistent chat assistant runs alongside every step, so pantry edits, meal swaps, and constraint changes can happen in plain language instead of only through forms.

---

## 04 — Differentiation

Existing tools — MyFitnessPal, Mealime, MacroFactor, Eat This Much — each solve one piece. Prospre comes closest of any competitor found to date: it already combines real macro-fit meal generation (USDA-grounded, not LLM-guessed) with dietary/dislike filtering and grocery lists in one app — the "macros + meal planning" half of the gap. But it has no dollar-budget input (its grocery optimization targets waste reduction, not a price ceiling) and no pantry awareness (a deliberate product choice by its own team). The market gap isn't a missing tool; it's a missing connection between macro precision, meal planning, budget, and pantry — all four, together.

> "Make this chicken stir-fry — you already have soy sauce, it hits your protein target, it fits your budget, and you've never rated it below 4 stars." No competitor today can make that recommendation, because none connects macro precision + meal planning **with budget and pantry awareness** — MacroMap can, because it holds all four data points simultaneously.

This is not a consolidation play. It is a **contextual reasoning play**: the value is generated at the intersection of data sources that currently live in separate apps.

---

## 05 — Technical Architecture

Built as an AI agent orchestrating four distinct data sources via the Model Context Protocol (MCP), enabling clean separation and future substitution of any layer.

| MCP Layer | Description |
|-----------|-------------|
| **Recipe + Nutrition MCP** | **Spoonacular API** (paid, $29/month — 1,500 points/day). Single API call returns recipe + per-ingredient nutrition data together via `/recipes/complexSearch`. Accepts macro targets and dietary filters directly, eliminating any custom ingredient parsing layer. 5,000+ recipes. Evaluated against Edamam ($38/month minimum for equivalent functionality) — Spoonacular wins on value. Also backs the AI composition fallback below: when no recipe matches (or ignores pantry ingredients), Claude proposes one, but every ingredient's macros are still pulled from Spoonacular's ingredient-level endpoint, never estimated. |
| **Price MCP** | **Spoonacular's own ingredient `estimatedCost` field, primary source (switched July 2026)** — no new vendor, reuses the recipe/nutrition dependency above; a structured number, not text to parse. Web search (Tavily, preferred over Brave for its no-credit-card free tier) is now a **fallback only**, used when Spoonacular has no cost data for an ingredient. *(Originally Tavily-first; live testing found its LLM-synthesized answer can extract the wrong price from a multi-price search result, a failure mode Spoonacular's structured field doesn't have.)* Both sources are estimates only, not real-time retail data. Manual override essential. Upgrade path: Kroger API. |
| **Pantry MCP** | Custom-authored MCP: pantry inventory, dietary constraints, dislikes, allergies, weekly budget. The personalization layer — now read *before* meal generation from day one (moved up from V2), biasing recipe selection toward what's on hand. **Substantially reworked July 2026:** pantry-to-ingredient matching is now an LLM identity classifier (Claude Haiku, forced tool-call, cached globally) judging name-level identity rather than Spoonacular id or plain string matching — needed because one real ingredient often resolves to several different ids across a plan's recipes. Cross-unit-category conversion (e.g. pantry stated in ml vs. a recipe line in grams) is resolved via a real, ingredient-density-aware Spoonacular API call, not an LLM guess — live-confirmed accurate. A matched item's quantity draws down a pool across every matching line (fixed a real double-counting bug); a line only excludes entirely when no matching pantry item has a usable quantity, not the original all-or-nothing behavior. As of July 25 2026, this same matching also feeds a live depletion tracker inside meal *ranking* itself (not just the grocery list), so pantry credit shrinks as slots consume stock during generation and during the standalone swap action. |
| **Conversational Agent Layer** | The same orchestrator (Claude, Sonnet tier) held as a persistent chat session across the whole flow, not just a one-shot generation trigger. Lets users edit pantry contents, swap meals, or change constraints in plain language — every chat action calls the same underlying mutation the UI buttons already call. No separate infrastructure; this is a session-state change to the existing orchestrator, not a new agent. |
| **Barcode MCP** | Open Food Facts API — free, no API key required. Browser camera scanning via ZXing-js. Lets users scan grocery items to instantly populate the pantry log, removing manual entry friction. V2 — manual pantry entry itself now ships in MVP; this adds a lower-friction entry method. |
| **Video Layer** | YouTube deep-link per meal (MVP: link to YouTube search results, no API needed). Post-MVP: in-app embed via YouTube Data API v3 free tier (10,000 units/day). |
| **Calendar Export** | `.ics` file generation via the `ics` npm package. One-tap export of the weekly meal plan to Google Calendar or Apple Calendar — no OAuth, no API quota. |
| **App & Auth Layer** | Next.js (App Router, TypeScript) on Vercel — one codebase for frontend and the API routes that call Spoonacular/Tavily, keeping those keys server-side only. Supabase (Postgres) holds user profiles, pantry/constraints, ratings, and both plan-generation caches; its built-in anonymous auth converts a guest session straight into a permanent account at Step 5, with no manual data migration. Net infra cost pre-revenue: $0 beyond Spoonacular's $29/month. |

---

## 06 — Monetisation

Freemium subscription with feature-gated tiers. Free tier validates the core loop and drives top-of-funnel. Paid tiers gate features that cost real API usage (price lookups, pantry sync) and advanced analytics.

| Plan | Price | Target |
|------|-------|--------|
| **Free** | $0/month | Get started, validate the core loop |
| **Pro** | $9/month | Serious gym-goers cutting or bulking |
| **Coach** | $20/month | PTs and nutrition coaches |

**Free includes:** Weekly meal plan (3 meals/day, no budget constraint), allergy + dietary filtering (safety feature — never gated), basic macro tracking, grocery list without price estimates, recipe video links, calendar export, manual pantry entry (F6, local — generation-time biasing, grocery-list exclusion), and the conversational plan assistant (F11) — these two add no *Spoonacular/Tavily* cost beyond what Free's generation/swap calls already include, but F11's chat parsing, the F3 AI composition fallback, and the new post-generation plan critique (July 2026) are all real Sonnet-tier Claude calls whose volume isn't yet budgeted (see PRD OQ8) — none have run against the real Anthropic API yet, since no key is configured. *(Tier placement is a default, not yet user-validated — revisit if either turns out to be a meaningful cost or differentiation lever once usage data comes in.)*

**Pro includes:** Budget-aware meal planning, per-ingredient price estimates (Spoonacular primary, Tavily fallback — see Price MCP above), pantry cloud sync across devices (V2 — local-only pantry storage is Free/MVP), full nutrition dashboard with weekly analytics, shopping list export. **Caveat (see Section 07's budget-reconciliation risk, now High):** "budget-aware meal planning" currently constrains a recipe-level price heuristic at generation time only — it's confirmed live that the real grocery total doesn't track the stated budget, so this differentiator's real-world output needs a fix before it's leaned on further in marketing.

**Coach includes:** Multiple client profiles, client-facing meal plan sharing, advanced analytics, priority support.

---

## 07 — Risks & Mitigations

| Level | Risk | Mitigation |
|-------|------|------------|
| **Medium** | User research is informal only | Early demand signal validated: founder conversations with friends and forum posts show genuine interest and willingness to pay. Risk is not zero — informal interest doesn't guarantee conversion or retention. Mitigation: run 5–10 structured interviews before full build to validate macro-vs-budget priority, willingness to pay at $9/month, and which features matter most. |
| **Medium — re-upgraded from Low-Medium** | Spoonacular API cost & capacity dependency | Spoonacular is a paid dependency from day one ($29/month). The July 2026 recompute that downgraded this risk (all 21 meals share one query per plan, not three) turned out to rest on a stale assumption — a later fix gave each meal type a realistic, non-uniform macro share instead of an even 1/3 split, breaking the cache-collapse the recompute relied on. **A live recompute (2026-07-22) across a representative 15-profile mix (not cherry-picked) found real cost averaging at least ~34.2 points/generation, giving real capacity of only ~44 generations/day (~306/week) — roughly HALF the ~600/week KR2 needs, not comfortably above it.** Re-upgraded to Medium; the tier-upgrade trigger should be treated as a near-term concern (roughly ~510 active users system-wide before hitting the ceiling, likely before KR1's 1,000 *paying* subscribers given normal free/paid funnel ratios), not a distant one. Revenue break-even remains 4 Pro subscribers at this tier — unaffected, that's a cost question not a capacity one. Mitigation unchanged: Edamam is a validated fallback vendor ($38/month); MCP architecture makes the recipe layer swappable. Not yet root-caused exactly which mechanism drives the higher cost (candidates: the broken cache-collapse above, and/or the post-generation plan-critic/repair pass adding a real query per flagged slot) — worth a dedicated investigation before this tier is relied on at scale. **Separate quota bug found and fixed July 15 2026, unaffected by the above:** the fixed snack/add-on ingredient pool was being re-fetched live on every generation, uncached — burned ~46.5 of a fresh 50-point key on one hard-profile test before failing outright. Fixed by pinning that static, non-user-specific data; same generation now costs ~1 point for that specific path. |
| **Medium** | Price estimate accuracy | Spoonacular's ingredient cost data (primary, switched July 2026 after live testing found Tavily's web-search price extraction could grab the wrong figure from a multi-price result) and Tavily (fallback only) are both approximate, not real-time retail data. Mitigated by manual override; upgrade path is Kroger API for real-time retail prices. |
| **High — re-upgraded from Medium, confirmed July 25 2026** | F4's real grocery total is never checked against F2/F3's stated budget | The two numbers come from independent mechanisms — F3's budget-aware filtering checks a recipe-level Spoonacular estimate during generation, F4 prices real ingredients separately — and nothing in the code compares them (see PRD OQ9). **Live-tested across 4 profiles spanning $35–$275 stated weekly budget: all four landed in the same $78–90/week real total, with no UI warning.** Stated budget currently has no measurable effect on the real number — this directly undercuts "budget-aware planning," the Pro tier's main differentiator (Section 06). Mitigation options already scoped, none built yet: surface the real total against the stated budget with an over/under indicator; bias generation toward real ingredient cost; react after the fact; or relabel the field. Needs a product-direction decision before the next round of Pro-tier messaging. |
| **Medium** | Single point of failure on Spoonacular for plan generation | If the API is down or the daily quota is exhausted, serve the user's cached last-successful plan with a "temporarily unavailable" banner rather than a blank or error state — never a dead end. |
| **Medium** | AI-composed/edited recipes and snack add-ons might feel unrealistic or lower-quality even when macro-accurate | Ground every ingredient's macros in Spoonacular's ingredient-level nutrition data, never LLM-estimated; cap snack add-ons at ≤15–20% of a meal's calories and one per slot; only trigger AI composition after Spoonacular's cascade fallback is exhausted, not as a default path. Track acceptance/swap rate by meal source and tighten the trigger threshold if AI-touched meals underperform (see hypotheses.md H8). **Implemented July 15 2026, not yet live-tested with a real key:** a portion-realism check now rejects an AI-composed meal outright if any ingredient's solved amount is unrealistic (found live: naive sizing asked for 346g of tofu), on top of the grounding rule already in place. A new post-generation plan critique (one Claude call reviewing the whole week, deterministic accept/reject on any flagged slot) was also added to catch cross-cutting variety/fit problems no per-slot check can see — see ai-agents.md Agent 1. Both remain gated behind an `ANTHROPIC_API_KEY` not yet configured; deferred by explicit decision. |
| **Medium (new, found July 15 2026)** | Severe allergy/diet stacking can collapse a plan far below its macro target even though every constraint holds | Live-tested: vegan + nut allergy + soy allergy left two of the fixed snack/add-on pool's three macro roles with zero safe options, and most recipe slots also blocked by genuine corpus scarcity — one live plan landed at 17% of its weekly calorie target. Not a safety failure (zero allergen violations throughout) but a real usability failure for a plausible user segment. Mitigation, not yet built: add 2-3 more vegan+nut+soy-safe options per affected pool role (e.g. pea protein powder, sunflower seed butter). See `engine-audit-2026-07-15.md`. |
| **Low** | Search API rate limits | Free tiers cap daily queries. Gate price lookups behind Pro plan to align cost with revenue. |

---

## 08 — MVP Scope

**In MVP**
- Macro target input
- Weekly meal plan generation — pantry-aware from day one
- Pantry log — manual entry, generation-time biasing (now also feeding a quantity-aware depletion tracker inside ranking itself, not just the grocery list), LLM identity matching + real unit conversion for grocery-list reduction (moved up from V2)
- Conversational plan assistant — chat-driven pantry/meal/constraint edits alongside the existing UI
- AI recipe composition/edit fallback and snack/add-on gap-closer, grounded in Spoonacular's ingredient nutrition data, for when no Spoonacular recipe fits
- Deduped shopping list, quantities scaled to what's actually planned per meal
- Per-ingredient price estimates (Spoonacular primary, web search fallback) + manual override
- Dietary restrictions, allergies, dislikes, budget (constraints layer, unchanged)
- Basic nutrition dashboard
- Dietary preference & allergy filtering
- Recipe video links (YouTube deep-link per meal — no API required)
- Weekly meal plan export to calendar (.ics file download)
- "Get inspiration" deep-link to r/MealPrepSunday and r/EatCheapAndHealthy filtered by goal

**V2**
- Meal ratings (F7) — thumbs up/down after eating; low-rated meals excluded from future plans
- Barcode scanning for pantry (F8) (Open Food Facts API + ZXing-js browser camera) — manual pantry entry itself ships in MVP
- Pantry item auto-expiry (7 days) unless refreshed
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
- ~~What does onboarding look like?~~ **Resolved: Hybrid onboarding.** User enters weight, height, age, biological sex, activity level, and goal (cut / bulk / maintain). App calculates TDEE via Mifflin-St Jeor formula and suggests macro targets. User can accept or manually override. Available on free tier — no API cost, no reason to gate it. (Biological sex added during implementation — Mifflin-St Jeor's BMR constant requires it and earlier drafts omitted the field.)
- ~~What macro split does the app use?~~ **Resolved: Fixed defaults for MVP, user can nudge values.** No custom split UI — reduces complexity and decision fatigue. Dietary style presets (keto, high-carb, plant-based) are Post-MVP.

| Goal | Protein | Fat | Carbs |
|------|---------|-----|-------|
| Cut | 2.2g/kg bodyweight | 25% of calories | Remainder |
| Bulk | 1.8g/kg bodyweight | 25% of calories | Remainder |
| Maintain | 1.6g/kg bodyweight | 30% of calories | Remainder |

- ~~Which licensed recipe API — Spoonacular or Edamam?~~ **Resolved: Spoonacular at $29/month.** Edamam evaluated and rejected — requires two separate subscriptions ($9 recipe + $29 nutrition = $38/month minimum) for equivalent functionality. Spoonacular's single API covers both at lower cost.

---

*MacroMap · Product Brief Draft v1 · June 2026 · Confidential*
