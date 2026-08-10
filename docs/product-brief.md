# MacroMap — Product Brief

> From weekly goal to grocery bag — without the spreadsheets.

**Stage:** Pre-seed concept | **Category:** Health & Nutrition · AI-powered | **Model:** Freemium SaaS | **Date:** June 2026

---

## 01 — The Problem

People who want to eat to a macro target lose hours every week across multiple apps, websites, and personal notes to plan meals, source recipes, and track macros. No single tool connects these data points simultaneously.

> "I use a lot of websites and personal notes to track everything. It takes so much time just to make sure I'm hitting my protein."

The tools exist — but they don't talk to each other. No single product connects macro targets, recipe discovery, and personal preferences in one continuous flow.

---

## 02 — Target Users

**Primary — Cutting & Bulking**
Gym-goers, athletes, and fitness-focused individuals tracking specific macro targets (protein/carb/fat/calories). Already disciplined and data-driven. Willing to pay for precision and time savings. Highly vocal in communities — strong word-of-mouth potential.

---

## 03 — The Solution

The user states a weekly goal — **"hit 150g protein a day"** — and MacroMap handles everything downstream: a planned week of meals and a consolidated shopping list.

```
Set Goal → Meal Plan → Grocery List
```

| Step | Description |
|------|-------------|
| 01 Set Goal | Macro targets, preferences, allergies, optional pantry contents |
| 02 Meal Plan | AI-generated weekly plan matched to requirements — pantry-aware from the start, with a conversational assistant to adjust it in plain language |
| 03 Grocery List | Deduped shopping list |

Users can optionally log what's already in their pantry — active from day one, not a later add-on — so the app builds meals around existing inventory and avoids redundant purchases. A persistent chat assistant runs alongside every step, so pantry edits, meal swaps, and constraint changes can happen in plain language instead of only through forms.

---

## 04 — Differentiation

Existing tools — MyFitnessPal, Mealime, MacroFactor, Eat This Much — each solve one piece. Prospre comes closest of any competitor found to date: it already combines real macro-fit meal generation (USDA-grounded, not LLM-guessed) with dietary/dislike filtering and grocery lists in one app — but it has no pantry awareness (a deliberate product choice by its own team). The market gap isn't a missing tool; it's a missing connection between macro precision, meal planning, and pantry awareness — together.

> "Make this chicken stir-fry — you already have soy sauce, and it hits your protein target." No competitor today can make that recommendation, because none connects macro precision + meal planning **with pantry awareness** — MacroMap can, because it holds all three data points simultaneously.

This is not a consolidation play. It is a **contextual reasoning play**: the value is generated at the intersection of data sources that currently live in separate apps.

---

## 05 — Technical Architecture

Built as an AI agent orchestrating multiple distinct data sources via the Model Context Protocol (MCP), enabling clean separation and future substitution of any layer.

| MCP Layer | Description |
|-----------|-------------|
| **Recipe + Nutrition MCP** | **Spoonacular API** (paid, $29/month — 1,500 points/day). Single API call returns recipe + per-ingredient nutrition data together via `/recipes/complexSearch`. Accepts macro targets and dietary filters directly, eliminating any custom ingredient parsing layer. 5,000+ recipes. Evaluated against Edamam ($38/month minimum for equivalent functionality) — Spoonacular wins on value. Also backs the AI composition fallback below: when no recipe matches (or ignores pantry ingredients), Claude proposes one, but every ingredient's macros are still pulled from Spoonacular's ingredient-level endpoint, never estimated. |
| **Pantry MCP** | Custom-authored MCP: pantry inventory, dietary constraints, dislikes, allergies. The personalization layer — now read *before* meal generation from day one (moved up from V2), biasing recipe selection toward what's on hand. **Substantially reworked July 2026:** pantry-to-ingredient matching is now an LLM identity classifier (Claude Haiku, forced tool-call, cached globally) judging name-level identity rather than Spoonacular id or plain string matching — needed because one real ingredient often resolves to several different ids across a plan's recipes. Cross-unit-category conversion (e.g. pantry stated in ml vs. a recipe line in grams) is resolved via a real, ingredient-density-aware Spoonacular API call, not an LLM guess — live-confirmed accurate. A matched item's quantity draws down a pool across every matching line (fixed a real double-counting bug); a line only excludes entirely when no matching pantry item has a usable quantity, not the original all-or-nothing behavior. As of July 25 2026, this same matching also feeds a live depletion tracker inside meal *ranking* itself (not just the grocery list), so pantry credit shrinks as slots consume stock during generation and during the standalone swap action. |
| **Conversational Agent Layer** | The same orchestrator (Claude, Sonnet tier) held as a persistent chat session across the whole flow, not just a one-shot generation trigger. Lets users edit pantry contents, swap meals, or change constraints in plain language — every chat action calls the same underlying mutation the UI buttons already call. No separate infrastructure; this is a session-state change to the existing orchestrator, not a new agent. |
| **Calendar Export** | `.ics` file generation via the `ics` npm package. One-tap export of the weekly meal plan to Google Calendar or Apple Calendar — no OAuth, no API quota. |
| **App & Auth Layer** | Next.js (App Router, TypeScript), currently deployed on the class Azure platform (Vercel was the original target). One codebase for frontend and the API routes that call Spoonacular, keeping those keys server-side only. Supabase (Postgres) holds user profiles, pantry/constraints, and chat history. **Auth, superseded:** originally Supabase's built-in anonymous auth, converting a guest session into a permanent account once the user needed to save progress across sessions — that mechanism was removed (migration `0034`); **Auth0 is now the sole identity provider**, requiring a real account before onboarding even starts, with no guest tier. Net infra cost pre-revenue: $0 beyond Spoonacular's $29/month. |

---

## 06 — Monetisation

Freemium subscription with feature-gated tiers. Free tier validates the core loop and drives top-of-funnel. Paid tiers gate pantry cloud sync and other convenience features.

| Plan | Price | Target |
|------|-------|--------|
| **Free** | $0/month | Get started, validate the core loop |
| **Pro** | $9/month | Serious gym-goers cutting or bulking |
| **Coach** | $20/month | PTs and nutrition coaches |

**Free includes:** Weekly meal plan (3 meals/day), allergy + dietary filtering (safety feature — never gated), grocery list, calendar export, manual pantry entry (F5, local — generation-time biasing, grocery-list exclusion), and the conversational plan assistant (F7) — F7's chat parsing, the F3 AI composition fallback, and the post-generation plan critique are all real Sonnet-tier Claude calls now running live against the real Anthropic API (`ANTHROPIC_API_KEY` is configured) whose volume still isn't formally budgeted (see PRD OQ8) — worth measuring now that real usage data can actually be collected. *(Tier placement is a default, not yet user-validated — revisit if this turns out to be a meaningful cost or differentiation lever once usage data comes in.)*

**Pro includes:** Pantry cloud sync across devices (V2 — local-only pantry storage is Free/MVP), shopping list export.

**Coach includes:** Multiple client profiles, client-facing meal plan sharing, advanced analytics, priority support.

---

## 07 — Risks & Mitigations

| Level | Risk | Mitigation |
|-------|------|------------|
| **Medium** | User research is informal only | Early demand signal validated: founder conversations with friends and forum posts show genuine interest and willingness to pay. Risk is not zero — informal interest doesn't guarantee conversion or retention. Mitigation: run 5–10 structured interviews before full build to validate willingness to pay at $9/month, and which features matter most. |
| **Medium — re-upgraded from Low-Medium** | Spoonacular API cost & capacity dependency | Spoonacular is a paid dependency from day one ($29/month). The July 2026 recompute that downgraded this risk (all 21 meals share one query per plan, not three) turned out to rest on a stale assumption — a later fix gave each meal type a realistic, non-uniform macro share instead of an even 1/3 split, breaking the cache-collapse the recompute relied on. **A live recompute (2026-07-22) across a representative 15-profile mix (not cherry-picked) found real cost averaging at least ~34.2 points/generation, giving real capacity of only ~44 generations/day (~306/week) — roughly HALF the ~600/week KR2 needs, not comfortably above it.** Re-upgraded to Medium; the tier-upgrade trigger should be treated as a near-term concern (roughly ~510 active users system-wide before hitting the ceiling, likely before KR1's 1,000 *paying* subscribers given normal free/paid funnel ratios), not a distant one. Revenue break-even remains 4 Pro subscribers at this tier — unaffected, that's a cost question not a capacity one. Mitigation unchanged: Edamam is a validated fallback vendor ($38/month); MCP architecture makes the recipe layer swappable. Not yet root-caused exactly which mechanism drives the higher cost (candidates: the broken cache-collapse above, and/or the post-generation plan-critic/repair pass adding a real query per flagged slot) — worth a dedicated investigation before this tier is relied on at scale. **Separate quota bug found and fixed July 15 2026, unaffected by the above:** the fixed snack/add-on ingredient pool was being re-fetched live on every generation, uncached — burned ~46.5 of a fresh 50-point key on one hard-profile test before failing outright. Fixed by pinning that static, non-user-specific data; same generation now costs ~1 point for that specific path. |
| **Medium** | Single point of failure on Spoonacular for plan generation | If the API is down or the daily quota is exhausted, serve the user's cached last-successful plan with a "temporarily unavailable" banner rather than a blank or error state — never a dead end. |
| **Medium** | AI-composed/edited recipes and snack add-ons might feel unrealistic or lower-quality even when macro-accurate | Ground every ingredient's macros in Spoonacular's ingredient-level nutrition data, never LLM-estimated; cap snack add-ons at ≤15–20% of a meal's calories and one per slot; only trigger AI composition after Spoonacular's cascade fallback is exhausted, not as a default path. Track acceptance/swap rate by meal source and tighten the trigger threshold if AI-touched meals underperform (see hypotheses.md H6). **Implemented July 15 2026, now live:** a portion-realism check rejects an AI-composed meal outright if any ingredient's solved amount is unrealistic (found live: naive sizing asked for 346g of tofu), on top of the grounding rule already in place. A post-generation plan critique (one Claude call reviewing the whole week, deterministic accept/reject on any flagged slot) was also added to catch cross-cutting variety/fit problems no per-slot check can see — see ai-agents.md Agent 1. `ANTHROPIC_API_KEY` is now configured; both run against the real API in production, with several rounds of live-testing bugs already found and fixed (see hypotheses.md H6). |
| **Medium (new, found July 15 2026)** | Severe allergy/diet stacking can collapse a plan far below its macro target even though every constraint holds | Live-tested: vegan + nut allergy + soy allergy left two of the fixed snack/add-on pool's three macro roles with zero safe options, and most recipe slots also blocked by genuine corpus scarcity — one live plan landed at 17% of its weekly calorie target. Not a safety failure (zero allergen violations throughout) but a real usability failure for a plausible user segment. Mitigation, not yet built: add 2-3 more vegan+nut+soy-safe options per affected pool role (e.g. pea protein powder, sunflower seed butter). See `engine-audit-2026-07-15.md`. |

---

## 08 — MVP Scope

**In MVP**
- Macro target input
- Weekly meal plan generation — pantry-aware from day one
- Pantry log — manual entry, generation-time biasing (now also feeding a quantity-aware depletion tracker inside ranking itself, not just the grocery list), LLM identity matching + real unit conversion for grocery-list reduction (moved up from V2)
- Conversational plan assistant — chat-driven pantry/meal/constraint edits alongside the existing UI
- AI recipe composition/edit fallback and snack/add-on gap-closer, grounded in Spoonacular's ingredient nutrition data, for when no Spoonacular recipe fits
- Deduped shopping list, quantities scaled to what's actually planned per meal
- Dietary restrictions, allergies, dislikes (constraints layer, unchanged)
- Dietary preference & allergy filtering
- Weekly meal plan export to calendar (.ics file download)

**V2**
- Pantry item auto-expiry (7 days) unless refreshed

**Post-MVP**
- Receipt scanning for automatic pantry updates
- Coach tier with client profiles
- Mobile app
- Community recipe ratings
- B2B partnerships with gyms & coaches

---

## 09 — Open Questions

- ~~What is the final product name?~~ **Resolved: MacroMap.**
- ~~What is the geographic launch market?~~ **Resolved: United States.** Recipe defaults and regulatory considerations scoped to US market at launch.
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
