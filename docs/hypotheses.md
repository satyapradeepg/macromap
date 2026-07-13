# MacroMap — Falsifiable Hypotheses

> How will you test your ideas before building them?

**Stage:** Pre-seed | **Date:** July 2026

---

## What is a falsifiable hypothesis?

A statement that can be proven wrong by real data. For each assumption MacroMap rests on, this document defines:
- The hypothesis (what we believe)
- How to test it (method)
- What success looks like (measurable threshold)
- What failure means (what we do if wrong)

---

## H1 — Macro trust: users will follow AI-generated targets

**Hypothesis:** Users who see their TDEE-calculated macro targets will accept them as-is or make only minor adjustments — and will follow the resulting meal plan without abandoning it due to distrust of the numbers.

**Source:** PRD Assumption A1 — *"if users don't trust the numbers, retention collapses"*

**Test method:**
- Track "macro override rate" during onboarding: what % of users change the suggested values by >20%?
- Run a post-week-1 in-app survey: "Did you trust the macros MacroMap gave you?" (1–5 scale)
- Compare week-1 retention between users who accepted vs. heavily modified their targets

**Success threshold:**
- Override rate < 30%
- Trust rating ≥ 4/5 from ≥70% of respondents
- Week-1 retention within 5% between accept vs. modify groups

**Failure action:** If override rate >50% or trust rating <3.5, invest in explainability (show the Mifflin-St Jeor formula, cite TDEE sources, let users compare to competing calculators).

---

## H2 — Pricing: $9/month is below users' willingness to pay

**Hypothesis:** Users in the primary segment (cutting or bulking) will convert from Free to Pro at $9/month within 90 days if the product delivers on its core promise.

**Source:** PRD Assumption A5 — *"High risk — mispricing kills conversion"*

**Test method:**
- Pre-launch: run 5–10 structured interviews with Marcus/Priya-type users; ask "how much would you pay?" before showing the price
- Post-launch: measure free-to-Pro conversion rate at 30, 60, and 90 days
- Track churn reason for cancelled Pro subscriptions

**Success threshold:**
- Pre-launch interviews: ≥60% of participants name $9 or higher unprompted
- Post-launch: ≥15% of free users convert within 90 days (KR3)
- Churn due to "too expensive": <20% of cancellations

**Failure action:** If conversion <10%, test a $6/month price point or adjust the Pro feature gate to include more value (e.g., move calendar export to Free, gate recipe video embeds instead).

---

## H3 — Time savings: MacroMap meaningfully reduces meal-planning time

**Hypothesis:** Users who plan meals manually today will save ≥30 minutes per week using MacroMap.

**Source:** Product Brief — *"Reclaim 2+ hours every week"*

**Test method:**
- Pre-launch: ask 10 target users to time their current Sunday meal-planning routine
- Post-launch week 2: in-app prompt "How much time did MacroMap save you this week?" (open numeric input)
- Compare onboarding completion speed as a proxy for plan generation speed

**Success threshold:**
- ≥70% of users report saving ≥30 minutes/week
- Average reported time saving ≥45 minutes/week

**Failure action:** If users report <20 minutes saved, investigate where time is lost (onboarding friction, swap loops, grocery list corrections) and streamline the slowest step.

---

## H4 — Recipe variety: Spoonacular's library sustains 4–8 weeks without repetition

**Hypothesis:** The Spoonacular recipe library (5,000+ results matching macro constraints) is large enough that users do not encounter repeated meals within a single 4-week period.

**Source:** PRD Assumption A2

**Test method:**
- Track repeat recipe rate server-side from day one: what % of a user's weekly plan overlaps with their prior 3 weeks?
- Monitor the `excludeIds` exclusion list growth rate per user

**Success threshold:**
- Repeat rate < 15% across any 4-week rolling window
- No user reports "I keep getting the same meals" in first 30 days of feedback

**Failure action:** If repeat rate >30%, expand query diversity by rotating between Spoonacular's cuisine types, adding a "no-repeat" hard constraint (`excludeIds`), or triggering earlier upgrade to a broader Spoonacular tier.

---

## H5 — Price accuracy: Tavily estimates are close enough that users don't feel misled

**Hypothesis:** Web search price estimates from Tavily are accurate enough (within 20% of actual checkout price) that users don't feel misled when they shop.

**Source:** PRD Assumption A3 — *"budget users will notice"*

**Test method:**
- Track manual price correction rate in F4: what % of Tavily estimates get overridden?
- Post-shop prompt (week 2): "How close was your estimated total to your actual receipt?" (Much lower / About right / Much higher)
- Monitor correlation between price correction rate and Pro churn

**Success threshold:**
- Manual override rate < 25% of items
- ≥60% of users rate estimate accuracy as "About right"

**Failure action:** If override rate >40%, surface the manual override more prominently and/or integrate Kroger API sooner for US users where real retail data is available.

---

## H6 — Pantry engagement: users will log their pantry without barcode scanning (V2)

**Hypothesis:** Once the pantry log (F6) ships in V2, users will manually enter 3+ pantry items in the first two weeks it's available, enough for the pantry layer to meaningfully affect meal plan generation.

**Source:** PRD Assumption A4 — *"if friction is too high, pantry feature won't be used"*

**Note:** Pantry log (F6) itself, not just barcode scanning (F8), ships in V2 — there is no MVP pantry feature to test. This hypothesis can only be run after V2 launches, not in MVP's first two weeks.

**Test method:**
- Measure pantry log completion rate: % of users who add ≥1 item in first 2 weeks after F6 ships
- Track average pantry size at end of that 2-week window
- F8 (barcode scanning) ships alongside F6 in V2 — this tests the manual-entry baseline before barcode is prioritized

**Success threshold:**
- ≥40% of users add ≥3 pantry items in the first 2 weeks after F6 ships
- Average pantry size ≥5 items at end of that window

**Failure action:** If completion <20%, prioritize barcode scanning (F8) within the V2 build, or surface a pantry onboarding prompt immediately after first meal plan generation.

---

## H7 — Retention: users return weekly to generate a new plan

**Hypothesis:** ≥50% of users who generate a first meal plan will return in week 4 to generate another.

**Source:** PRD KR5 — *"50% of users return in week 4"*

**Test method:**
- Track weekly plan generation events per user over a 30-day cohort
- Identify the drop-off point (after week 1? week 2?) for users who churn early

**Success threshold:**
- ≥50% of week-1 users generate a new plan in week 4

**Failure action:** If retention <30% by week 4, investigate whether drop-off is due to variety exhaustion, trust issues, or workflow friction. Address the primary root cause before scaling acquisition.

---

## Hypothesis Priority & Test Sequence

| # | Hypothesis | Test timing | Risk if wrong |
|---|---|---|---|
| H2 | $9/month pricing | Before launch (interviews) | High — kills conversion |
| H1 | Macro trust | Week 1 post-launch | High — kills retention |
| H3 | Time savings | Week 2 post-launch | High — core value prop |
| H7 | Weekly retention | Week 4 post-launch | High — business model |
| H5 | Price accuracy | Week 2 post-launch | Medium — Pro feature risk |
| H4 | Recipe variety | Month 1 post-launch | Medium — variety drives retention |
| H6 | Pantry engagement | Week 2 post-V2-launch | Medium — no MVP pantry feature to test |

---

*MacroMap · Falsifiable Hypotheses v1 · July 2026*
