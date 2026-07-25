# MacroMap

> From weekly goal to grocery bag — without the spreadsheets.

**Stage:** Pre-seed concept · **Category:** Health & Nutrition, AI-powered · **Model:** Freemium SaaS

MacroMap is an AI meal planning app. A user states a weekly goal — *"hit 150g protein/day on a $90 budget"* — and MacroMap generates a full week of meals, a deduped grocery list, and a nutrition dashboard. No existing tool connects macro targets, recipe discovery, grocery prices, and personal preferences in one continuous flow; MacroMap's value sits at the intersection of all four.

## Contents

| Doc | What's in it |
|---|---|
| [`docs/product-brief.md`](docs/product-brief.md) | Problem, target users, solution, differentiation, monetisation, MVP scope |
| [`docs/PRD-MacroMap.md`](docs/PRD-MacroMap.md) | Full MVP requirements — user flow, epics, all 11 features, tiers, technology, assumptions, release plan |
| [`docs/personas.md`](docs/personas.md) | Three personas (Marcus, Priya, Jordan) with feature-to-pain-point mapping |
| [`docs/hypotheses.md`](docs/hypotheses.md) | 8 falsifiable hypotheses with test methods and success thresholds |
| [`docs/ai-agents.md`](docs/ai-agents.md) | The 6-agent AI architecture (Orchestrator, Recipe, Price, Pantry, Barcode, Calendar Export) — the Orchestrator now also runs a persistent conversational session and an AI recipe-composition fallback, both grounded in Spoonacular's ingredient-level data |
| [`docs/macromap-prototype.html`](docs/macromap-prototype.html) | Standalone interactive prototype — click through the full workflow in a browser |

To view the prototype, download `docs/macromap-prototype.html` and open it directly in any browser — no build step required.

## Repo layout

- **`docs/`** — planning artifacts (product brief, PRD, personas, hypotheses, AI agent design, interactive prototype). Nothing here runs.
- **`web/`** — the actual application: Next.js (App Router, TypeScript) + Supabase. See [`web/README.md`](web/README.md) for the standard Next.js commands, and below for MacroMap-specific setup.

### Running the app

```
cd web
pnpm install
cp .env.local.example .env.local   # fill in your Supabase project's URL + anon key
pnpm dev
```

You'll also need to run every file in `web/supabase/migrations/` (currently `0001` through `0020`, in order) once in your Supabase project's SQL editor, and enable **Authentication → Sign In / Providers → Anonymous** — MacroMap lets guests complete onboarding through the grocery list with no account (see PRD Section 7.1), which relies on Supabase anonymous auth.

Run `pnpm test` to run the Vitest suite (unit tests for ranking, grocery aggregation, pantry matching, and unit conversion).

## The core workflow

```
Onboarding → Set Weekly Goal → Generate Meal Plan → Grocery List → Track → Weekly Cycle (repeat)
```

1. **Onboarding** — weight, height, age, activity level, goal (cut/bulk/maintain). TDEE calculated via Mifflin-St Jeor, macro targets suggested.
2. **Set Weekly Goal** — confirm macro targets, an optional grocery budget, and optional pantry contents (moved up from V2 — see below).
3. **Generate Meal Plan** — 21 macro-matched, allergy-safe, budget-aware, pantry-aware meals a week. An automatic tolerance-widening fallback means a plan is never a dead end; when that's still not enough, an AI composition/edit fallback (or a small grounded snack add-on) closes the gap, and a persistent conversational assistant lets you adjust the pantry, swap a meal, or change a constraint in plain language throughout.
4. **Grocery List** — deduplicated, priced, with a "$—/add manually" fallback when a price estimate isn't available.
5. **Track** — daily and weekly nutrition dashboard, including off-plan meal logging.
6. **Weekly Cycle** — next week pre-fills from the saved profile; low-rated meals are excluded automatically.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Recipe + nutrition | Spoonacular API ($29/mo) | One call returns recipe + per-serving nutrition; 5,000+ recipes |
| Price estimates | Tavily Search API (free tier) | No credit card required; estimates only, manual override supported |
| Pantry & constraints | Custom MCP | Allergies, dislikes, budget, ratings; pantry contents read at generation time (quantity-aware, not just present/absent) and again at grocery-list time — matching handles cross-category unit conversion (e.g. ml pantry stock against a gram-denominated recipe line) and an LLM identity classifier for name-matching (not id-matching, since the same ingredient often resolves to several different Spoonacular ids) |
| Conversational agent layer | Same orchestrator (Claude, Sonnet tier), held as a persistent chat session | Edit pantry, swap a meal, or change a constraint in plain language — no separate infrastructure |
| Barcode scanning (V2) | Open Food Facts + ZXing-js | Free, no API key; manual pantry entry itself is now MVP, this just adds a lower-friction entry method |
| Recipe videos | YouTube deep-link | Zero API cost for MVP |
| Calendar export | `ics` npm package | No OAuth, works with Google/Apple/Outlook |
| App framework + hosting | Next.js (App Router) on Vercel | One codebase for frontend + API routes; API keys stay server-side |
| Database + auth | Supabase (Postgres) | Profiles, pantry/ratings, plan-generation caches; built-in anonymous auth powers the guest→account flow |

## Tiers

- **Free** — macro-matched meal plan, allergy/dietary filtering (never gated), basic tracking, grocery list without prices, recipe video links, calendar export, manual pantry entry, conversational plan assistant
- **Pro ($9/mo)** — budget-aware planning, live price estimates, full analytics dashboard, pantry cloud sync across devices (V2 — local-only pantry storage is Free/MVP)
- **Coach ($20/mo, post-MVP)** — multi-client profiles, plan sharing, advanced analytics

## Team

- **Satya** — Founder, Product & Design
- **Claude** — Engineering & QA

---

*Confidential · Pre-seed*
