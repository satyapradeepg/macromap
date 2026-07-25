# MacroMap — User Personas

> Derived from the product brief. Primary segment: cutting & bulking. Secondary: budget-conscious healthy eaters.

---

## Persona 1 — The Dedicated Bulker

**Name:** Marcus, 26  
**Occupation:** Software Engineer  
**Location:** Austin, TX  
**Goal:** Bulk — gain 10 lbs of lean muscle over 4 months  
**Macro target:** 3,200 kcal/day · 200g protein · 380g carbs · 90g fat  
**Weekly grocery budget:** $120 (flexible, prioritises hitting macros over saving money)

### About
Marcus has been lifting for 3 years and recently moved from casual training to a structured bulk. He knows his numbers well — TDEE, macros, ideal protein sources — but spends 2–3 hours every Sunday planning the week. He cross-references protein-per-dollar on spreadsheets, saves recipes in browser tabs, and logs meals in MyFitnessPal. He is data-driven at work and wants the same rigour applied to his nutrition.

### Pain Points
- Spends too long planning meals that meet both his calorie surplus and protein floor
- Recipe sites don't filter by macro ratios — he finds a recipe he likes, then manually calculates if it fits
- His grocery list lives in Notes app and frequently has duplicate items or missing quantities
- Switches between 4 apps in a single meal-planning session

### What He'd Pay For
A single app that takes his weekly macro targets, generates a varied meal plan, and produces a ready-to-shop grocery list. Variety matters — eating chicken and rice every day kills adherence.

### Features That Map to His Needs
| Feature | Why it helps Marcus |
|---|---|
| F3 Meal plan generation | Replaces his 2–3 hour Sunday spreadsheet session |
| F9 Recipe video links | Discovers new meals without leaving the app — drives variety |
| F4 Grocery list | Replaces his Notes app; deduped quantities save time at checkout |
| F10 Calendar export | Fits his data-driven, structured weekly routine |
| F7 Meal ratings (V2) | Surfaces his favourite high-protein meals automatically over time |

### Quote
> "I know exactly what I need to eat. I just don't want to spend my Sunday figuring out how to get there."

### Willingness to Pay
**Pro tier ($9/month)** — immediately. Would upgrade to Coach if he ever trains clients.

---

## Persona 2 — The Time-Pressed Cutter

**Name:** Priya, 31  
**Occupation:** Marketing Manager  
**Location:** San Francisco, CA  
**Goal:** Cut — lose 8 lbs before a holiday in 10 weeks  
**Macro target:** 1,650 kcal/day · 140g protein · 140g carbs · 50g fat  
**Weekly grocery budget:** $75 (budget matters, not a hard constraint)

### About
Priya works long hours and meal preps on Sundays when she can. She's tried MyFitnessPal and found logging tedious after the first week. She's done Mealime for recipe ideas but it doesn't respect her macro targets. She understands macros at a basic level but doesn't want to do the maths herself — she just wants to be told what to buy and cook. Adherence breaks down mid-week when she runs out of prepped food and orders takeout.

### Pain Points
- No app plans the full week AND generates the shopping list AND tracks against her targets in one place
- Mealime gives her recipes but ignores her protein target entirely
- Logging in MyFitnessPal after cooking feels punishing — she'd rather plan ahead
- Mid-week adherence collapses when the plan isn't set out clearly

### What She'd Pay For
A frictionless Sunday routine: input her goal, get a plan, get a list, shop, done. Bonus if the app flags when she's trending under protein mid-week.

### Features That Map to Her Needs
| Feature | Why it helps Priya |
|---|---|
| F3 Meal plan generation | Eliminates the multi-app Sunday session entirely |
| F10 Calendar export | Meal plan in her calendar = no mid-week decision fatigue |
| F5 Nutrition dashboard | Mid-week protein alerts catch adherence drift before it's too late |
| F9 Recipe video links | Reduces drop-off when she encounters an unfamiliar recipe |
| F4 Grocery list with prices | Budget awareness without having to track manually |
| F11 Conversational plan assistant | When mid-week takeout breaks the plan, she can just tell the assistant to swap a meal or adjust rather than starting over — directly addresses her adherence-collapse pain point |

### Quote
> "I don't have time to be my own nutritionist. Just tell me what to buy."

### Willingness to Pay
**Pro tier ($9/month)** — yes, if the first week saves her more than 30 minutes of planning.

---

## Persona 3 — The Budget-Conscious Student

**Name:** Jordan, 21  
**Occupation:** Undergraduate student (Kinesiology)  
**Location:** Columbus, OH  
**Goal:** Maintain weight and eat healthier without overspending  
**Macro target:** Loosely aware — wants enough protein, not obsessive  
**Weekly grocery budget:** $50 hard limit

### About
Jordan studies exercise science and knows the theory but struggles to apply it on a student budget. Eats a lot of repetitive cheap meals (pasta, eggs, canned tuna) because planning anything more varied feels overwhelming. Has tried apps but finds most of them either too complicated or paywalled. Would love to know "what can I cook this week for under $50 that isn't boring."

### Pain Points
- Budget is the primary constraint, macros are secondary
- Can't afford trial-and-error with groceries — wastes money on ingredients that don't get used
- Recipe apps suggest meals with expensive or obscure ingredients
- No awareness of what's already in the pantry when planning — frequently re-buys things

### What He'd Pay For
Free tier is the entry point. Would convert to Pro if the budget-aware grocery list genuinely saves him money and reduces food waste. Price-sensitive — $9/month is a stretch. **Flag (2026-07-25):** a confirmed product gap directly threatens this — live testing found real grocery totals land at $78–90/week regardless of stated budget ($35 to $275 all tested the same), well above Jordan's $50 hard limit. Until the budget/real-total reconciliation gap (product-brief.md Section 07, PRD OQ9) is resolved, Jordan is the persona most likely to feel actively misled by "budget-aware," not converted by it.

### Features That Map to His Needs
| Feature | Why it helps Jordan |
|---|---|
| F6 Pantry log (Free, MVP) | Builds meals around what's already at home from day one — directly fixes his "no awareness of what's in the pantry" pain point, no longer a V2 wait |
| F4 Grocery list (Free tier) | Stops him re-buying ingredients he already has |
| F11 Conversational plan assistant (Free) | Can just tell it what's in his fridge instead of filling out a form — lowers the entry friction that made him bounce off other apps |
| F8 Barcode scanning (V2) | Scans items after shopping to auto-populate pantry — removes manual entry friction |
| Reddit deep-link | Free inspiration from r/EatCheapAndHealthy without leaving the app |
| F3 Budget-aware planning (Pro) | The intended conversion trigger — if it demonstrably saves him money, he upgrades. **Currently at risk:** the stated budget doesn't yet constrain the real grocery total (see flag above) — resolve before leaning on this row for Jordan-targeted messaging |

### Quote
> "I know eggs and rice are cheap and healthy. I just want someone to make it less boring without blowing my budget."

### Willingness to Pay
**Free tier first.** Potential Pro conversion at 3–6 months if retention holds.

---

## Persona Summary

| | Marcus | Priya | Jordan |
|---|---|---|---|
| **Primary driver** | Macro precision | Time savings | Budget |
| **Goal** | Bulk | Cut | Maintain |
| **Budget flexibility** | High | Medium | None |
| **Tech savviness** | High | Medium | Medium |
| **Willingness to pay** | Immediate Pro | Pro if value proven | Free → slow convert |
| **Retention risk** | Low (habitual tracker) | Medium (busy, drops off) | High (price-sensitive) |
| **Word-of-mouth potential** | High (gym community) | Medium | Low |

---

*MacroMap · Personas v1 · June 2026*
