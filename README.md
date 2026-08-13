# MacroMap

> From weekly goal to grocery bag — without the spreadsheets.

**Stage:** Pre-seed concept · **Category:** Health & Nutrition, AI-powered · **Model:** Freemium SaaS

MacroMap is an AI meal planning app. A user states a weekly goal — *"hit 150g protein a day"* — and MacroMap generates a full week of meals and a deduped grocery list. No existing tool connects macro targets, recipe discovery, and personal preferences in one continuous flow; MacroMap's value sits at the intersection of all three.

## Contents

| Doc | What's in it |
|---|---|
| [`docs/product-brief.md`](docs/product-brief.md) | Problem, target users, solution, differentiation, monetisation, MVP scope |
| [`docs/PRD-MacroMap.md`](docs/PRD-MacroMap.md) | Full MVP requirements — user flow, epics, all features, tiers, technology, assumptions, release plan |
| [`docs/personas.md`](docs/personas.md) | Personas (Marcus, Priya) with feature-to-pain-point mapping |
| [`docs/hypotheses.md`](docs/hypotheses.md) | Falsifiable hypotheses with test methods and success thresholds |
| [`docs/ai-agents.md`](docs/ai-agents.md) | The AI architecture (Orchestrator, Recipe, Pantry, Calendar Export) — the Orchestrator now also runs a persistent conversational session and an AI recipe-composition fallback, both grounded in Spoonacular's ingredient-level data |
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

You'll also need to run every file in `web/supabase/migrations/` (currently `0001` through `0036`, in order) once in your Supabase project's SQL editor. Auth is handled by **Auth0**, not Supabase — every route (including onboarding) requires a real login, there is no guest/anonymous tier. The app reads `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, and `AUTH0_CLIENT_SECRET` directly (`src/lib/auth0.ts`), plus `AUTH0_SECRET` and `APP_BASE_URL`, which the `@auth0/nextjs-auth0` SDK expects by convention — all five are already templated in `web/.env.local.example`, fill them in from an Auth0 application you control.

Run `pnpm test` to run the Vitest suite (unit tests for ranking, grocery aggregation, pantry matching, unit conversion, the conversational assistant's intent classification, and the AI meal-composition/critic/repair fallbacks).

## The core workflow

```
Onboarding → Set Weekly Goal → Generate Meal Plan → Grocery List
```

1. **Onboarding** — weight, height, age, activity level, goal (cut/bulk/maintain). TDEE calculated via Mifflin-St Jeor, macro targets suggested.
2. **Set Weekly Goal** — confirm macro targets and optional pantry contents (moved up from V2 — see below).
3. **Generate Meal Plan** — 21 macro-matched, allergy-safe, pantry-aware meals a week. An automatic tolerance-widening fallback means a plan is never a dead end; when that's still not enough, an AI composition/edit fallback (or a small grounded snack add-on) closes the gap, and a persistent conversational assistant lets you adjust the pantry, swap a meal, or change a constraint in plain language throughout.
4. **Grocery List** — deduplicated, consolidated quantities across the whole week.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Recipe + nutrition | Spoonacular API ($29/mo) | One call returns recipe + per-serving nutrition; 5,000+ recipes |
| Pantry & constraints | Custom MCP | Allergies, dislikes; pantry contents read at generation time (quantity-aware, not just present/absent) and again at grocery-list time — matching handles cross-category unit conversion (e.g. ml pantry stock against a gram-denominated recipe line) and an LLM identity classifier for name-matching (not id-matching, since the same ingredient often resolves to several different Spoonacular ids) |
| Conversational agent layer | Same orchestrator (Claude, Sonnet tier), held as a persistent chat session | Edit pantry, swap a meal, or change a constraint in plain language — no separate infrastructure |
| Calendar export | Hand-built `.ics` (RFC 5545) generator, no external library | No OAuth, works with Google/Apple/Outlook |
| App framework + hosting | Next.js (App Router) | One codebase for frontend + API routes; API keys stay server-side |
| Database | Supabase (Postgres) | Profiles, pantry, chat history, plan-generation caches |
| Auth | Auth0 | Sole identity provider (since migration `0034`) — gates every route from the first page, no guest/anonymous tier |

## Team

- **Satya** — Founder, Product & Design
- **Claude** — Engineering & QA

---

*Confidential · Pre-seed*
