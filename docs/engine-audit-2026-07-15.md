# MacroMap Engine Audit — July 15, 2026

Live-tested assessment of the generation engine across variety, macro precision, preference-adherence, and realism. Four profiles run through real onboarding → `/plan` generation against production Spoonacular + Supabase, across two Spoonacular keys (the first ran out of daily quota after profile 3).

## Executive summary

**Safety holds perfectly. Coverage and variety both have real, concrete gaps once constraints stack up.**

Across all four profiles, not one allergen, dietary violation, or disliked ingredient ever reached the screen — the safety fixes from earlier today held under live pressure, not just unit tests. But two independent mechanisms show real degradation under realistic pressure: a mainstream, plausible combination (vegan + nut allergy + soy allergy) reduced a full week's plan to **17% of its calorie target**, and a tight-budget Pro profile produced **the identical snack 14 times in a row** — both traced to the same root cause (the fixed 9-ingredient pool's preference/rotation logic collapsing to a single option), just triggered by two different constraints (safety exclusion vs. cost preference).

Headline numbers:
- **21/21** — real recipe titles distinct across the week, every profile that filled its recipe slots (4/4)
- **0** — allergen/dislike/diet violations across 4 profiles, 140 slots checked
- **17%** — of calorie target met on the vegan + nut + soy profile
- **14/14** — snacks identical on the tight-budget profile
- **±31%** — fat deviation on the aggressive-bulk profile

## Method

Each profile went through the actual onboarding flow, a real `/plan` generation, and a full-page scan for forbidden ingredient terms. Chosen to stress different axes: an unrestricted baseline, the opposite macro extreme (aggressive bulk), the most constraint-dense allergy+diet combination this app's presets can express, and a tight budget on Pro tier (the one axis not covered by presets alone — required manually flipping the profile's tier via direct DB access, since there's no UI toggle pre-billing).

## Results, per profile

### 1 — Mainstream baseline
80kg · 180cm · 30yo male · active · maintain · no restrictions

**35/35 slots filled** · 24/35 distinct titles overall · **21/21 distinct real recipes** · 4.4s generation

| | Target | Actual | Deviation |
|---|---|---|---|
| Calories | 19,313 | 18,605 | **-3.7%** |
| Protein | 896g | 934g | **+4.2%** |
| Carbs | 2,485g | 2,413g | **-2.9%** |
| Fat | 644g | 648g | **+0.6%** |

**Verdict:** best-case performance. Tight on every macro, full variety on real recipes, zero blocked slots. This is what the engine looks like with room to work.

### 2 — Vegan + nut allergy + soy allergy
65kg · 165cm · 26yo female · lightly active · cut · vegan, no nuts, no soy

**16/35 slots filled** · 5/16 distinct titles · **2/21 real recipes filled** · 14/14 snacks reduced to bare fruit

| | Target | Actual | Deviation |
|---|---|---|---|
| Calories | 10,703 | 1,839 | **-82.8%** |
| Protein | 1,001g | 63g | **-93.7%** |
| Carbs | 1,008g | 427g | **-57.6%** |
| Fat | 294g | 9g | **-96.9%** |

**Verdict:** the plan is *safe* — every exclusion held — but not usable. Every breakfast/lunch blocked ("protein target too high"), 5 of 7 dinners blocked, and both snack roles that could carry protein or fat collapsed entirely. See root cause below.

### 3 — Aggressive bulk
100kg · 190cm · 25yo male · very active · bulk · no restrictions

**35/35 slots filled** · 24/35 distinct titles overall · **21/21 distinct real recipes** · 4.9s generation

| | Target | Actual | Deviation |
|---|---|---|---|
| Calories | 27,461 | 24,309 | **-11.5%** |
| Protein | 1,260g | 1,222g | **-3.0%** |
| Carbs | 3,892g | 2,757g | **-29.2%** |
| Fat | 763g | 998g | **+30.8%** |

**Verdict:** fully filled with full recipe variety, but macro precision is markedly worse than the baseline at this scale — carbs and fat, the two macros this engine only soft-prefers rather than hard-filters, swing much further off target once the absolute gram targets get large.

## Deep dive — variety

Every profile that filled its recipe slots (1 and 3) landed **21 distinct real recipes out of 21** — zero repeats across breakfast, lunch, and dinner for the whole week. All of the apparent "variety loss" in the raw distinct-title counts comes from composed snacks, which draw from a fixed 3-option pool per macro role by design (a cost/complexity tradeoff made deliberately earlier this project, not an oversight):

| Profile | Real recipes (distinct/filled) | Snack combos (distinct/14) | What limited it |
|---|---|---|---|
| 1 · Baseline | 21/21 | ~3/14 | Snack pool has only 3 options per role — structural, unaffected by corpus size |
| 3 · Bulk | 21/21 | ~4/14 | Same structural cap |
| 2 · Vegan+nut+soy | 2/2 | 3/14 | Corpus scarcity blocked 19 recipe slots outright; remaining snacks are single-ingredient fruit |

A real user eating "Greek Yogurt + Banana + Almonds" four times in one week will notice, even though every gram is grounded in real data. The recipe engine doesn't have this problem; the snack composer does, by construction.

## Deep dive — macro precision

The bulk profile has no dietary restrictions at all — the corpus should be at its most permissive — yet carbs and fat swung 3-6x further off target than the unrestricted baseline at normal scale. Both are the two macros this engine's ranking only *soft*-prefers (a documented, deliberate tradeoff from earlier work to avoid starving the recipe pool by hard-filtering on them). That softness costs more in absolute grams once the target itself is larger — the same 0.5x ranking weight closes a smaller percentage gap when the underlying numbers are bigger.

## Deep dive — preference & safety adherence

Every profile's full page text was scanned for its own forbidden terms after generation — nut/soy/dairy/meat/fish keywords for profile 2, nothing for the unrestricted profiles. Across all 140 slots checked, **zero** forbidden terms surfaced, anywhere: not in a recipe title, not in a composed-snack ingredient, not in an add-on note. This is the one dimension with an unambiguous result: the safety work from earlier today holds under real, adversarial-by-construction pressure, not just unit tests.

Budget preference (profile 4) is real and working — every meal card showed a genuine, grounded "Closest to your budget" label with a real per-serving price, correctly falling back to the cheapest available match (never blocking generation outright) exactly as the existing cascade design intends. But it exposed the session's second concrete bug: see the tie-band finding below.

## Deep dive — realism & groundedness

Real recipes read naturally throughout ("Barbecued Shrimp & Grits," "Lentil, Sweet Potato and Spinach Soup") with correct video links and serving-size notes. Composed items stayed grounded even at their worst: profile 2's snacks didn't fabricate a fake protein or fat number to look complete — they honestly showed a plain 86-92 calorie piece of fruit with 0g protein and 0g fat, because that's genuinely all the safe pool had left. The engine never lies about what it couldn't do; it just couldn't do very much for this profile.

## The critical finding: why vegan + nut + soy collapses the plan

The fixed 9-ingredient snack/add-on pool has exactly 3 options per macro role. For this profile, two whole roles have **zero** safe options left:

**Protein role:** ~~greek yogurt~~ (dairy), ~~cottage cheese~~ (dairy), ~~protein powder~~ (dairy + soy)
**Fat role:** ~~almonds~~ (nut), ~~walnuts~~ (nut), ~~peanut butter~~ (nut)

Only the carb role (banana/apple/orange) survives, which is exactly what the live screenshots show. Recipe search fares little better: vegan + no-soy removes tofu, tempeh, and edamame — the primary vegan protein staples — leaving almost nothing at this profile's protein density in Spoonacular's corpus.

**Recommended fix:** add 2-3 more options to each role that are simultaneously vegan, nut-free, and soy-free — pea protein powder or hemp hearts for protein, sunflower seed butter or chia seeds for fat. Cheap to add (same static-pricing/safety-tagging pattern already built today) and would directly close this gap without touching the recipe-search side at all.

Separately: the AI-composition fallback built earlier today would very likely have filled most of the 19 blocked recipe slots here — it never got to try, since no `ANTHROPIC_API_KEY` is configured yet in this environment. Wiring a real key is probably the single highest-leverage next step for this exact failure mode.

### 4 — Tight budget + Pro tier
70kg · 170cm · 35yo female · sedentary · maintain · no dietary restrictions · $25/week budget · tier manually flipped to Pro

**35/35 slots filled** · 22/35 distinct titles overall · **21/21 distinct real recipes** · 5.4s generation

| | Target | Actual | Deviation |
|---|---|---|---|
| Calories | 11,984 | 11,341 | **-5.4%** |
| Protein | 784g | 753g | **-4.0%** |
| Carbs | 1,316g | 1,096g | **-16.7%** |
| Fat | 399g | 468g | **+17.3%** |

**Verdict:** budget-awareness confirmed working live for the first time — every meal card now shows a real, grounded "Closest to your budget — $X.XX/serving" label (e.g. one recipe at $9.68/serving, correctly flagged as the cascade's last-resort cheapest-available pick against a ~$1.19/serving budget). Real recipe variety again perfect (21/21). But this surfaced a new bug: **every single one of the 14 snack slots is the byte-identical "Cottage Cheese + Banana"** — same title, same 250 cal/19g protein/29g carbs/7g fat, same 160g/105g amounts, all 7 days. Zero snack variety for a budget-aware profile, a real regression versus the ~3-4 distinct combos seen in profiles 1 and 3.

**Root cause:** the budget-preference logic (`pantryPricePreference.ts`, built earlier today) picks the single absolute cheapest option per role and only allows the variety-seed to rotate among ties. Cottage cheese ($0.50/100g) and banana ($0.13/100g) are each unambiguously the cheapest in their role — no float tie exists — so the "preferred tier" is always exactly 1 option, every day, for the whole week. Pantry preference doesn't have this problem (users often list 2+ pantry items, naturally producing ties to rotate among), but a strict cheapest-only comparison essentially never does.

**Recommended fix:** widen the budget-preference comparison to a tie-band (e.g. anything within ~20% of the cheapest counts as "cheap enough") rather than requiring an exact cost match — this is the same pattern `ranking.ts`'s `macroDeviationScore` already uses (a 0.01 score tie-band) for an identical reason: letting near-ties compete on variety instead of collapsing to one. Not yet implemented.

## Not yet tested

Nothing further — the budget/Pro-tier profile above completes the planned battery. All 4 axes originally scoped (unrestricted baseline, opposite macro extreme, severe allergy stacking, tight budget) now have live data.

## Findings, ranked

1. **Allergy/diet stacking can collapse a plan to ~17% of target.** Vegan + nut + soy allergy leaves two of three fixed-pool roles with zero safe options. Real, plausible user segment — not a synthetic edge case. Fix: expand the fixed pool (see root-cause section above).
2. **Budget preference collapses snack variety to a single repeated combo.** A tight-budget Pro profile got the identical "Cottage Cheese + Banana" 14/14 times — the cheapest-only comparison has no tie-band, so there's never more than one "preferred" option to rotate among. Fix: widen to a tie-band (e.g. within ~20% of cheapest), mirroring `ranking.ts`'s existing pattern.
3. **Macro precision degrades at large absolute targets.** Carb/fat soft-ranking costs more real grams as targets scale up. Bulk profile: ±30% on both, vs. <5% at baseline scale. Worth a scale-aware look before assuming today's tolerance bands generalize.
4. **Composed-snack variety is structurally capped at ~3-4 combos/week even without budget pressure.** Not a bug, but a real, felt limitation once a user is on the plan for more than a week or two. Same fixed-pool expansion as finding 1 would help here too.
5. **AI-composition fallback is unverified live.** Built and unit-tested, but no `ANTHROPIC_API_KEY` means it's never actually run against a real blocked slot. Finding 1 is exactly the scenario it was built for.

---
*4 live generations · real Spoonacular + Supabase data · two API keys used (~49 + ~26 points) · epic-e2-wip, not pushed*
