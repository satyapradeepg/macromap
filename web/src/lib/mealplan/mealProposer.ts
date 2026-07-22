// Calls Claude to propose WHAT belongs in a dish for a genuinely blocked
// meal slot -- the one piece of judgment in this file; everything else
// (macros, sizing, safety, portion realism) is deterministic, per
// aiMealComposition.ts's grounding rule. Forces a tool call for
// structured output rather than parsing free-text JSON, since a
// malformed/prose response would otherwise need fragile parsing.
//
// Model id: per ai-agents.md's standing note, don't let this go stale --
// confirm against the latest available Sonnet-tier model at deploy time
// rather than trusting this string indefinitely.
const MODEL = "claude-sonnet-5";

import type { MacroTargets } from "./targets";
import type { MealProposal, MealRole } from "./aiMealComposition";

export interface ProposeMealInput {
  mealType: "breakfast" | "lunch" | "dinner";
  target: MacroTargets;
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
  pantryItemNames: string[];
}

const PROPOSE_MEAL_TOOL = {
  name: "propose_meal",
  description: "Propose a real, realistic dish and its ingredient list to fill a meal slot.",
  input_schema: {
    type: "object",
    properties: {
      dishName: { type: "string", description: "A real, specific dish name a person would recognize, e.g. 'Seitan Scramble with Spinach and Whole Wheat Toast'." },
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "A real, searchable whole-food or common grocery ingredient name (not a brand name)." },
            role: { type: "string", enum: ["protein", "carb", "fat", "fixed"] },
            fixedAmountG: { type: "number", description: "Only for role='fixed' (a small garnish/aromatic): a realistic gram amount, e.g. 40 for a side of spinach." },
          },
          required: ["name", "role"],
        },
      },
    },
    required: ["dishName", "ingredients"],
  },
};

// Protein-dense example suggestions for the prompt below, each tagged
// with what it conflicts with -- found live July 16 2026 (comprehensive
// engine test): the prompt used to hardcode "seitan, tempeh, lentils, a
// dense cheese, a lean meat" as example suggestions regardless of
// context, while listing the user's actual allergies/dietary style two
// lines above in the SAME prompt. For a vegan+soy-allergic profile,
// Claude proposed tempeh (a soy product) as the protein source in 9 of
// 10 real AI-composition attempts -- every one correctly rejected by the
// deterministic safety gate downstream, but burning the entire
// AI-compose budget on proposals doomed from the start. The model was
// following the concrete example over the abstract constraint listed
// above it. Filtering examples to only the ones actually safe for THIS
// call closes the contradiction at the source instead of hoping the
// model resolves it on its own -- this does not replace the real safety
// gate (isOpenEndedIngredientUnsafeFor, still the only thing this
// function's caller trusts), it just stops wasting attempts on
// suggestions that gate was always going to reject.
// Real density confirmed live 3x (2026-07-22, stacked-safety
// investigation): cooked lentils measured 9.02g protein/100g every time.
// Within the realistic 280g portion cap (aiMealComposition.ts's
// PORTION_BOUNDS_G.protein.max), that's a hard ceiling of ~25g protein --
// structurally incapable of a lunch-scale target (32-38g observed live)
// no matter how it's sized. A margin below that exact ceiling, not the
// ceiling itself: composeMealFromProposal sizes against whatever protein
// is still needed after fixed items are counted, so the raw target here
// is a slight overestimate of the true remaining gap, not an exact match.
const LENTILS_REALISTIC_PROTEIN_CEILING_G = 22;

const PROTEIN_EXAMPLES: Array<{
  name: string;
  conflictsWith: (ctx: { dietaryStyles: string[]; allergies: string[] }, targetProteinG?: number) => boolean;
}> = [
  { name: "seitan", conflictsWith: (ctx) => ctx.dietaryStyles.includes("gluten_free") || ctx.allergies.some((a) => /wheat|gluten/i.test(a)) },
  { name: "tempeh", conflictsWith: (ctx) => ctx.allergies.some((a) => /soy|soya/i.test(a)) },
  // Added July 16 2026, same live test as the tempeh fix above: once
  // tempeh/seitan/cheese/meat are all filtered out for a vegan+soy+nut+
  // dairy-restricted profile, "lentils" was the only example left --
  // but lentils are genuinely too low in protein density (~9g/100g) to
  // hit a demanding protein target within the realistic portion cap
  // (280g), so every proposal was rejected by the portion-realism check
  // instead of the safety check. Pea protein powder (~73g/100g, tagged
  // vegan/nut-free/soy-free/dairy-free/gluten-free in
  // staticIngredientMacros.ts) is dense enough to actually work for the
  // exact combination that has nothing else left.
  { name: "pea protein powder", conflictsWith: () => false },
  // Widened 2026-07-22: this fix ALREADY diagnosed lentils' weakness
  // above (that's why pea protein powder got added) but never actually
  // removed lentils from the list once a denser option existed --
  // live-confirmed the predictable result: Claude kept picking lentils
  // over pea protein powder anyway for a demanding target, the same
  // "follows the concrete example over the abstract density warning"
  // pattern already documented at this file's carb-budget hint. Now
  // conditionally excluded once the target is demanding enough that
  // lentils are structurally incapable of it -- still unconditionally
  // offered for a genuinely light target (a snack, a small dinner share)
  // where it's a perfectly fine option.
  { name: "lentils", conflictsWith: (_ctx, targetProteinG) => targetProteinG !== undefined && targetProteinG > LENTILS_REALISTIC_PROTEIN_CEILING_G },
  { name: "a dense cheese", conflictsWith: (ctx) => ctx.dietaryStyles.includes("vegan") || ctx.dietaryStyles.includes("dairy_free") || ctx.allergies.some((a) => /dairy|milk|lactose|whey|casein|cheese/i.test(a)) },
  { name: "a lean meat if the diet allows it", conflictsWith: (ctx) => ctx.dietaryStyles.includes("vegan") || ctx.dietaryStyles.includes("vegetarian") },
];

// lentils never conflicts (not a tracked allergen in this app), so this
// can never return empty -- the fallback is defensive only. Exported
// purely so tests can assert on the filtered list directly, rather than
// substring-matching the full prompt (which also uses "seitan cutlets"
// elsewhere as an unrelated naming-format example).
//
// targetProteinG (added 2026-07-22, stacked-safety investigation):
// optional so existing direct callers (tests, or a caller with no
// meaningful per-call target) keep today's behavior unchanged -- when
// omitted, lentils is never gated out regardless of density.
export function safeProteinExamples(ctx: { dietaryStyles: string[]; allergies: string[] }, targetProteinG?: number): string[] {
  const examples = PROTEIN_EXAMPLES.filter((e) => !e.conflictsWith(ctx, targetProteinG)).map((e) => e.name);
  return examples.length > 0 ? examples : ["lentils", "chickpeas"];
}

export function buildPrompt(input: ProposeMealInput): string {
  const { mealType, target, dietaryStyles, allergies, dislikes, pantryItemNames } = input;
  return `Propose a realistic ${mealType} to hit these targets as closely as a normal-sized portion reasonably can:
- ${Math.round(target.calories)} calories
- ${Math.round(target.proteinG)}g protein
- ${Math.round(target.carbsG)}g carbs
- ${Math.round(target.fatG)}g fat

Hard constraints -- never violate these, including hidden/derived forms (e.g. mayonnaise contains egg, Worcestershire sauce contains fish, most protein powder/seitan is not gluten-free):
- Dietary style: ${dietaryStyles.length ? dietaryStyles.join(", ") : "none"}
- Allergies (absolute, safety-critical -- think about hidden forms, not just the literal word): ${allergies.length ? allergies.join(", ") : "none"}
- Dislikes (avoid these ingredients entirely): ${dislikes.length ? dislikes.join(", ") : "none"}

${pantryItemNames.length ? `Pantry on hand (prefer using these where they genuinely fit the dish, but never at the expense of the constraints above or of realism): ${pantryItemNames.join(", ")}` : ""}

Requirements for your proposal:
1. Name a REAL, coherent, recognizable dish for ${mealType} -- not an arbitrary bag of ingredients. Someone should read the name and immediately picture a real meal.
2. Pick exactly one ingredient for each of the "protein", "carb", and "fat" roles, plus 0-2 small "fixed" ones for realism (a vegetable side, a garnish, a spice) -- fixed ones don't need to hit any macro, just be a normal small serving.
3. The "protein" ingredient MUST be dense enough to plausibly hit the protein target within a NORMAL single-meal portion (roughly 100-250g). Do not pick a low-density ingredient like plain tofu for a demanding protein target and expect a huge portion to make up for it -- pick something that's actually protein-dense enough for how much protein is actually needed here. Concretely: most beans/legumes/lentils are only ~8-10g protein per 100g, capping out around 25g protein even at a generous 250-280g portion -- if the protein target above is meaningfully higher than that, a bean/legume/lentil source alone cannot get there no matter how it's portioned; reach for a denser option instead. Options that fit the constraints above for this meal: ${safeProteinExamples({ dietaryStyles, allergies }, target.proteinG).join(", ")}. These are only starting points, not a fixed list -- the ingredient you pick must still respect every dietary style, allergy, and dislike listed above; never suggest one of these (or anything else) if it conflicts with a constraint above, even if it would otherwise be a great protein source.
4. Use real, specific, searchable ingredient names (e.g. "seitan cutlets", not "protein source").
5. Watch the carb budget, not just protein: a starchy legume or grain (lentils, quinoa, rice, beans) sized to hit the protein target on its own can easily blow the carb budget before the "carb" ingredient is even added -- e.g. enough lentils for 24g protein already carries ~50g of carbs. If the carb target is not generously larger than the protein target, prefer whichever option from the list in requirement 3 is protein-dense with the LEAST carbs of its own, so the carb ingredient has real room left to contribute -- do not reach for a new option outside that already-filtered list just to solve this. Never let this reasoning override a constraint above -- re-check every ingredient you're about to pick against the dietary style, allergies, and dislikes listed above before finalizing, even if a conflicting one would otherwise solve the carb budget well.`;
}

export async function proposeMealViaClaude(input: ProposeMealInput): Promise<MealProposal | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      tools: [PROPOSE_MEAL_TOOL],
      tool_choice: { type: "tool", name: "propose_meal" },
      messages: [{ role: "user", content: buildPrompt(input) }],
    }),
  });

  if (!response.ok) return null;

  const body = await response.json();
  const toolUse = (body.content ?? []).find((block: { type: string }) => block.type === "tool_use");
  if (!toolUse) return null;

  return validateProposal(toolUse.input);
}

// Batch-aware variant (added 2026-07-20) — the single-slot function above
// calls Claude once per blocked slot, each time with ONLY that slot's own
// target and zero visibility into the other slots also being filled this
// same generation. Found live: a genuinely blocked slot is never alone —
// orchestrate.ts's AI-compose fallback only ever runs on whatever's left
// after the entire recipe-search+reconciliation pipeline gives up, so by
// the time it fires there are usually 2-3+ blocked slots at once, all
// solved in isolation. This batches them into ONE call so Claude can trade
// off across the group (e.g. lean higher-protein on one dish, lower on
// another) instead of forcing every single dish to independently hit its
// own narrow share. Deliberately still not "the whole week" — scoped to
// exactly the slots THIS fallback is being asked to fill right now, same
// as the function above; the broader weekly-reconciliation system is a
// separate, already-existing concern (see reconciliation.ts).
export interface ProposeMealsBatchInput {
  slots: Array<{ mealType: "breakfast" | "lunch" | "dinner"; target: MacroTargets }>;
  aggregateTarget: MacroTargets;
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
  pantryItemNames: string[];
}

const PROPOSE_MEALS_BATCH_TOOL = {
  name: "propose_meals",
  description: "Propose several real, realistic dishes at once (one per requested slot), each with its own deliberately-allocated target, balanced together against a combined target.",
  input_schema: {
    type: "object",
    properties: {
      meals: {
        type: "array",
        description: "Exactly one entry per requested slot below, in the SAME order the slots were listed.",
        items: {
          type: "object",
          properties: {
            dishName: { type: "string", description: "A real, specific dish name a person would recognize, e.g. 'Seitan Scramble with Spinach and Whole Wheat Toast'." },
            targetCalories: { type: "number", description: "This SPECIFIC dish's own allocated calorie target -- your deliberate allocation, not necessarily the slot's even share. All meals' targetCalories together should sum close to the combined total given below." },
            targetProteinG: { type: "number", description: "This SPECIFIC dish's own allocated protein target in grams -- concentrate this higher for dishes built on a dense protein source, lower for others. All meals' targetProteinG together should sum close to the combined total given below." },
            targetCarbsG: { type: "number", description: "This SPECIFIC dish's own allocated carb target in grams." },
            targetFatG: { type: "number", description: "This SPECIFIC dish's own allocated fat target in grams." },
            ingredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "A real, searchable whole-food or common grocery ingredient name (not a brand name)." },
                  role: { type: "string", enum: ["protein", "carb", "fat", "fixed"] },
                  fixedAmountG: { type: "number", description: "Only for role='fixed' (a small garnish/aromatic): a realistic gram amount, e.g. 40 for a side of spinach." },
                },
                required: ["name", "role"],
              },
            },
          },
          required: ["dishName", "targetCalories", "targetProteinG", "targetCarbsG", "targetFatG", "ingredients"],
        },
      },
    },
    required: ["meals"],
  },
};

export function buildBatchPrompt(input: ProposeMealsBatchInput): string {
  const { slots, aggregateTarget, dietaryStyles, allergies, dislikes, pantryItemNames } = input;
  const slotLines = slots
    .map(
      (s, i) =>
        `Slot ${i + 1} (${s.mealType}) — individually needs roughly ${Math.round(s.target.calories)} cal / ${Math.round(s.target.proteinG)}g protein / ${Math.round(s.target.carbsG)}g carbs / ${Math.round(s.target.fatG)}g fat`,
    )
    .join("\n");

  // Gates the shared protein-example list against the MOST demanding
  // slot in this batch, not any single slot's own share -- the prompt
  // above explicitly tells Claude it can concentrate a slot's protein
  // well above its even share, so any slot here could plausibly end up
  // needing close to this batch's most demanding target. Conservative
  // by construction: might exclude lentils for a slot that would've been
  // fine with it, never the reverse.
  const maxSlotProteinG = Math.max(...slots.map((s) => s.target.proteinG));

  return `Propose ${slots.length} realistic meals to fill these slots, in this exact order:
${slotLines}

The individual numbers above are each slot's own even share, but what actually matters most is the COMBINED total across all ${slots.length} dishes together:
- ${Math.round(aggregateTarget.calories)} calories
- ${Math.round(aggregateTarget.proteinG)}g protein
- ${Math.round(aggregateTarget.carbsG)}g carbs
- ${Math.round(aggregateTarget.fatG)}g fat

You do NOT need every single dish to hit its own individual share exactly -- each meal you propose has its OWN target fields (targetCalories/targetProteinG/targetCarbsG/targetFatG) that you set yourself, and THOSE are what actually get used, not the even share shown above. If a slot's own protein share is demanding for a normal single-meal portion (roughly above 50g), the most reliable strategy is to CONCENTRATE rather than spread evenly: pick the single densest protein source available (protein powder, seitan, lean poultry) for 1-2 of these dishes, set THEIR targetProteinG notably higher than that slot's even share, and set the REMAINING dishes' targetProteinG lower (leaning more on carbs/fat instead) -- their targetCalories should still add up sensibly with the lower protein. This is much more likely to produce realistic portions across the whole batch than asking every dish to independently hit a demanding number. Only aim for near-even targets across dishes if every slot's own share is already easily achievable. Every dish's targets, added together, should land close to the combined total above -- exact precision isn't required (it will be auto-corrected), but a genuinely deliberate allocation is.

Hard constraints -- never violate these, including hidden/derived forms (e.g. mayonnaise contains egg, Worcestershire sauce contains fish, most protein powder/seitan is not gluten-free):
- Dietary style: ${dietaryStyles.length ? dietaryStyles.join(", ") : "none"}
- Allergies (absolute, safety-critical -- think about hidden forms, not just the literal word): ${allergies.length ? allergies.join(", ") : "none"}
- Dislikes (avoid these ingredients entirely): ${dislikes.length ? dislikes.join(", ") : "none"}

${pantryItemNames.length ? `Pantry on hand (prefer using these where they genuinely fit a dish, but never at the expense of the constraints above or of realism): ${pantryItemNames.join(", ")}` : ""}

Requirements for EACH proposal:
1. Name a REAL, coherent, recognizable dish for its meal type -- not an arbitrary bag of ingredients. Someone should read the name and immediately picture a real meal.
2. Set this dish's OWN targetCalories/targetProteinG/targetCarbsG/targetFatG deliberately (see the concentration guidance above) -- this is your real allocation for this specific dish, not a copy of the slot's even share.
3. Pick exactly one ingredient for each of the "protein", "carb", and "fat" roles, plus 0-2 small "fixed" ones for realism (a vegetable side, a garnish, a spice) -- fixed ones don't need to hit any macro, just be a normal small serving.
4. Each "protein" ingredient MUST be dense enough to plausibly hit THIS DISH'S OWN targetProteinG (the number you set above, not the slot's even share) within a NORMAL single-meal portion (roughly 100-250g). Do not pick a low-density ingredient like plain tofu for a demanding protein target and expect a huge portion to make up for it. Concretely: most beans/legumes/lentils are only ~8-10g protein per 100g, capping out around 25g protein even at a generous 250-280g portion -- if a dish's own targetProteinG is meaningfully higher than that, a bean/legume/lentil source alone cannot get there no matter how it's portioned; reach for a denser option instead for that dish. Options that fit the constraints above: ${safeProteinExamples({ dietaryStyles, allergies }, maxSlotProteinG).join(", ")}. These are only starting points, not a fixed list -- the ingredient you pick must still respect every dietary style, allergy, and dislike listed above; never suggest one of these (or anything else) if it conflicts with a constraint above, even if it would otherwise be a great protein source.
5. Use real, specific, searchable ingredient names (e.g. "seitan cutlets", not "protein source").
6. Watch each dish's own carb budget, not just its protein: a starchy legume or grain (lentils, quinoa, rice, beans) sized to hit a dish's targetProteinG on its own can easily blow that dish's targetCarbsG before the "carb" ingredient is even added -- e.g. enough lentils for 24g protein already carries ~50g of carbs. If a dish's carb allocation is not generously larger than its protein allocation, prefer whichever option from the list in requirement 4 is protein-dense with the LEAST carbs of its own for THAT dish, so its carb ingredient has real room left to contribute -- do not reach for a new option outside that already-filtered list just to solve this. Never let this reasoning override a constraint above -- re-check every ingredient you're about to pick against the dietary style, allergies, and dislikes listed above before finalizing, even if a conflicting one would otherwise solve a dish's carb budget well.
7. Return exactly ${slots.length} meals in the "meals" array, in the same order the slots were listed above.`;
}

// Pairs a validated proposal with its OWN per-dish target -- the thing
// that actually makes redistribution real. Without this, every dish in a
// batch got sized against the flat per-slot share regardless of what
// Claude conceptually intended (found live July 20 2026: the prompt
// promised freedom to concentrate protein into fewer dishes, but nothing
// downstream ever consumed that intent -- every proposal was still sized
// against the same fixed individual target). The target here is Claude's
// own deliberate allocation, rescaled below to guarantee it sums exactly
// to the real aggregate -- still just an ALLOCATION input to the same
// deterministic sizing math as before, never a substitute for it (the
// dish's actual final macros still come from real ingredient lookups,
// same grounding rule as everywhere else in this file).
export interface BatchMealProposal {
  proposal: MealProposal;
  target: MacroTargets;
}

const TARGET_FIELDS = ["targetCalories", "targetProteinG", "targetCarbsG", "targetFatG"] as const;

function parseMacroTargetFields(obj: Record<string, unknown>): MacroTargets | null {
  const values: number[] = [];
  for (const field of TARGET_FIELDS) {
    const v = obj[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
    values.push(v);
  }
  return { calories: values[0], proteinG: values[1], carbsG: values[2], fatG: values[3] };
}

// Never trusts the LLM's arithmetic -- Claude's stated per-dish targets
// are a deliberate ALLOCATION decision (which dish gets more/less), not
// reliable ground truth for the exact totals. Scales each macro
// independently so the rescaled targets sum EXACTLY to the real aggregate
// (per macro) while preserving each dish's relative share for that macro
// -- e.g. if Claude allocated a 3:1 protein ratio between two dishes, that
// ratio survives even though the absolute numbers get corrected.
export function rescaleToAggregate(rawTargets: MacroTargets[], aggregateTarget: MacroTargets): MacroTargets[] {
  const sum = rawTargets.reduce<MacroTargets>(
    (acc, t) => ({
      calories: acc.calories + t.calories,
      proteinG: acc.proteinG + t.proteinG,
      carbsG: acc.carbsG + t.carbsG,
      fatG: acc.fatG + t.fatG,
    }),
    { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  );

  const scaleFor = (key: keyof MacroTargets): number => (sum[key] > 0 ? aggregateTarget[key] / sum[key] : 1);
  const scales: MacroTargets = {
    calories: scaleFor("calories"),
    proteinG: scaleFor("proteinG"),
    carbsG: scaleFor("carbsG"),
    fatG: scaleFor("fatG"),
  };

  return rawTargets.map((t) => ({
    calories: t.calories * scales.calories,
    proteinG: t.proteinG * scales.proteinG,
    carbsG: t.carbsG * scales.carbsG,
    fatG: t.fatG * scales.fatG,
  }));
}

// Extracted as its own pure function (mirrors validateProposal above) so
// the malformed/mismatched-response handling is unit-testable without
// mocking fetch — this codebase's established pattern (proposeMealViaClaude
// itself has no dedicated unit test either; only validateProposal does).
// Returns null (never throws) for anything unusable -- one bad entry, or
// the wrong count, invalidates the WHOLE batch rather than trusting a
// partial result, same "never partially applied" discipline as everywhere
// else in this fallback.
export function validateBatchProposals(
  rawMeals: unknown,
  expectedCount: number,
  aggregateTarget: MacroTargets,
): BatchMealProposal[] | null {
  if (!Array.isArray(rawMeals) || rawMeals.length !== expectedCount) return null;

  const parsed: Array<{ proposal: MealProposal; rawTarget: MacroTargets }> = [];
  for (const raw of rawMeals) {
    const proposal = validateProposal(raw);
    if (!proposal) return null;
    if (typeof raw !== "object" || raw === null) return null;
    const rawTarget = parseMacroTargetFields(raw as Record<string, unknown>);
    if (!rawTarget) return null;
    parsed.push({ proposal, rawTarget });
  }

  const rescaled = rescaleToAggregate(
    parsed.map((p) => p.rawTarget),
    aggregateTarget,
  );
  return parsed.map((p, i) => ({ proposal: p.proposal, target: rescaled[i] }));
}

export async function proposeMealsBatchViaClaude(input: ProposeMealsBatchInput): Promise<BatchMealProposal[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (input.slots.length === 0) return null;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024 + input.slots.length * 512,
      tools: [PROPOSE_MEALS_BATCH_TOOL],
      tool_choice: { type: "tool", name: "propose_meals" },
      messages: [{ role: "user", content: buildBatchPrompt(input) }],
    }),
  });

  if (!response.ok) return null;

  const body = await response.json();
  const toolUse = (body.content ?? []).find((block: { type: string }) => block.type === "tool_use");
  if (!toolUse) return null;

  const rawMeals = (toolUse.input as Record<string, unknown> | null)?.meals;
  return validateBatchProposals(rawMeals, input.slots.length, input.aggregateTarget);
}

const VALID_ROLES: MealRole[] = ["protein", "carb", "fat", "fixed"];

// Never trusts the LLM's JSON shape blindly -- malformed output returns
// null (same "never fake progress" discipline as everywhere else), which
// the caller treats as a failed composition attempt, not a crash.
export function validateProposal(raw: unknown): MealProposal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.dishName !== "string" || !obj.dishName.trim()) return null;
  if (!Array.isArray(obj.ingredients)) return null;

  const ingredients = [];
  for (const item of obj.ingredients) {
    if (typeof item !== "object" || item === null) return null;
    const i = item as Record<string, unknown>;
    if (typeof i.name !== "string" || !i.name.trim()) return null;
    if (typeof i.role !== "string" || !VALID_ROLES.includes(i.role as MealRole)) return null;
    // Used to require a numeric fixedAmountG for every "fixed" item and
    // reject the whole proposal otherwise -- but fixedAmountG is genuinely
    // optional on ProposedIngredient, and the prompt itself never tells
    // Claude a gram amount is mandatory for a garnish/side ("don't need to
    // hit any macro, just be a normal small serving"). This gate rejected
    // proposals upstream of composeMealFromProposal's own
    // DEFAULT_FIXED_AMOUNT_G fallback (2026-07-21) before that fallback
    // could ever run in real production traffic -- found while wiring up
    // the carb-budget prompt hint, not by the live testing that found the
    // original bug (that testing called composeMealFromProposal directly,
    // bypassing this validator). A missing amount is not malformed input;
    // an invalid non-number one still is (e.g. a string), so that case
    // stays a hard reject below via the fixedAmountG-parsing check.
    if (i.role === "fixed" && i.fixedAmountG !== undefined && typeof i.fixedAmountG !== "number") return null;
    ingredients.push({
      name: i.name,
      role: i.role as MealRole,
      fixedAmountG: typeof i.fixedAmountG === "number" ? i.fixedAmountG : undefined,
    });
  }

  return { dishName: obj.dishName, ingredients };
}
