# MacroMap

> From weekly goal to grocery bag — without the spreadsheets.

**Stage:** Pre-seed concept · **Category:** Health & Nutrition, AI-powered · **Model:** Freemium SaaS

MacroMap is an AI meal planning app. A user states a weekly goal — *"hit 150g protein/day on a $90 budget"* — and MacroMap generates a full week of meals, a deduped grocery list, and a nutrition dashboard. No existing tool connects macro targets, recipe discovery, grocery prices, and personal preferences in one continuous flow; MacroMap's value sits at the intersection of all four.

## Contents

| Doc | What's in it |
|---|---|
| [`docs/product-brief.md`](docs/product-brief.md) | Problem, target users, solution, differentiation, monetisation, MVP scope |
| [`docs/PRD-MacroMap.md`](docs/PRD-MacroMap.md) | Full MVP requirements — user flow, epics, all 10 features, tiers, technology, assumptions, release plan |
| [`docs/personas.md`](docs/personas.md) | Three personas (Marcus, Priya, Jordan) with feature-to-pain-point mapping |
| [`docs/hypotheses.md`](docs/hypotheses.md) | 7 falsifiable hypotheses with test methods and success thresholds |
| [`docs/ai-agents.md`](docs/ai-agents.md) | The 6-agent AI architecture (Orchestrator, Recipe, Price, Pantry, Barcode, Calendar Export) |
| [`docs/macromap-prototype.html`](docs/macromap-prototype.html) | Standalone interactive prototype — click through the full workflow in a browser |

To view the prototype, download `docs/macromap-prototype.html` and open it directly in any browser — no build step required.

## The core workflow

```
Onboarding → Set Weekly Goal → Generate Meal Plan → Grocery List → Track → Weekly Cycle (repeat)
```

1. **Onboarding** — weight, height, age, activity level, goal (cut/bulk/maintain). TDEE calculated via Mifflin-St Jeor, macro targets suggested.
2. **Set Weekly Goal** — confirm macro targets and an optional grocery budget.
3. **Generate Meal Plan** — 21 macro-matched, allergy-safe, budget-aware meals a week, with an automatic tolerance-widening fallback so a plan is never a dead end.
4. **Grocery List** — deduplicated, priced, with a "$—/add manually" fallback when a price estimate isn't available.
5. **Track** — daily and weekly nutrition dashboard, including off-plan meal logging.
6. **Weekly Cycle** — next week pre-fills from the saved profile; low-rated meals are excluded automatically.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Recipe + nutrition | Spoonacular API ($29/mo) | One call returns recipe + per-serving nutrition; 5,000+ recipes |
| Price estimates | Tavily Search API (free tier) | No credit card required; estimates only, manual override supported |
| Pantry & constraints | Custom MCP | Allergies, dislikes, budget, ratings |
| Barcode scanning (V2) | Open Food Facts + ZXing-js | Free, no API key |
| Recipe videos | YouTube deep-link | Zero API cost for MVP |
| Calendar export | `ics` npm package | No OAuth, works with Google/Apple/Outlook |

## Tiers

- **Free** — macro-matched meal plan, allergy/dietary filtering (never gated), basic tracking, grocery list without prices, recipe video links, calendar export
- **Pro ($9/mo)** — budget-aware planning, live price estimates, full analytics dashboard, pantry sync (V2)
- **Coach ($20/mo, post-MVP)** — multi-client profiles, plan sharing, advanced analytics

## Team

- **Satya** — Founder, Product & Design
- **Claude** — Engineering & QA

---

*Confidential · Pre-seed*
