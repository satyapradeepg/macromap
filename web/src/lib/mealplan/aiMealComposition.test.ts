import { describe, it, expect, vi } from "vitest";
import {
  composeMealFromProposal,
  composeMealFromProposalDetailed,
  composeMealFromProposalBestEffort,
  describeRejectionForFeedback,
  type CompositionRejection,
  type GroundedIngredientData,
  type MealProposal,
} from "./aiMealComposition";
import type { DietaryContext } from "./openEndedIngredientSafety";

const NONE: DietaryContext = { dietaryStyles: [], allergies: [], dislikes: [] };

// Real live-fetched macro data (July 15 2026 spike). Cost left null in
// these fixtures -- these tests exercise portion/safety logic, not price,
// and null is the honest "no cost data" case, not a fabricated number.
const seitan: GroundedIngredientData = { id: 93654, name: "seitan cutlets", caloriesPer100g: 106, proteinGPer100g: 21.0, carbsGPer100g: 3.5, fatGPer100g: 1.18, estimatedCostCentsPer100g: null };
const tofu: GroundedIngredientData = { id: 10016213, name: "firm tofu", caloriesPer100g: 84, proteinGPer100g: 8.9, carbsGPer100g: 2.3, fatGPer100g: 4.4, estimatedCostCentsPer100g: null };
const bread: GroundedIngredientData = { id: 18075, name: "whole wheat bread", caloriesPer100g: 254, proteinGPer100g: 12.3, carbsGPer100g: 43.1, fatGPer100g: 3.55, estimatedCostCentsPer100g: null };
const oil: GroundedIngredientData = { id: 4053, name: "olive oil", caloriesPer100g: 884, proteinGPer100g: 0, carbsGPer100g: 0, fatGPer100g: 100, estimatedCostCentsPer100g: null };
const spinach: GroundedIngredientData = { id: 11457, name: "spinach", caloriesPer100g: 23, proteinGPer100g: 2.86, carbsGPer100g: 3.63, fatGPer100g: 0.39, estimatedCostCentsPer100g: null };
const chicken: GroundedIngredientData = { id: 1, name: "grilled chicken breast", caloriesPer100g: 165, proteinGPer100g: 31, carbsGPer100g: 0, fatGPer100g: 3.6, estimatedCostCentsPer100g: null };
const paprika: GroundedIngredientData = { id: 1032040, name: "smoked paprika", caloriesPer100g: 282, proteinGPer100g: 14.1, carbsGPer100g: 54, fatGPer100g: 12.9, estimatedCostCentsPer100g: null };
// Real USDA per-100g values (not live-fetched this session) -- used for
// the fat-role realism-bound regression test below.
const avocado: GroundedIngredientData = { id: 9038, name: "avocado", caloriesPer100g: 160, proteinGPer100g: 2.0, carbsGPer100g: 8.5, fatGPer100g: 14.7, estimatedCostCentsPer100g: null };

// Real target from the July 15 2026 nut-allergy live test's blocked breakfast slot.
const BREAKFAST_TARGET = { calories: 354.8, proteinG: 30.8, carbsG: 35.8, fatG: 9.8 };

function lookupFrom(data: Record<string, GroundedIngredientData>) {
  return vi.fn(async (query: string) => data[query.toLowerCase()] ?? null);
}

describe("composeMealFromProposal", () => {
  it("composes a real, well-portioned dish when the LLM picks a sufficiently protein-dense ingredient", async () => {
    const proposal: MealProposal = {
      dishName: "Seitan Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
        { name: "spinach", role: "fixed", fixedAmountG: 40 },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "whole wheat bread": bread, "olive oil": oil, spinach });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);

    expect(meal).not.toBeNull();
    expect(meal!.dishName).toBe("Seitan Scramble with Spinach and Whole Wheat Toast");
    // Every ingredient amount should be within a realistic portion.
    const seitanItem = meal!.ingredients.find((i) => i.ingredientName === "seitan cutlets")!;
    expect(seitanItem.amountG).toBeGreaterThanOrEqual(20);
    expect(seitanItem.amountG).toBeLessThanOrEqual(280);
    // Close to the real spike's computed result (140g).
    expect(seitanItem.amountG).toBe(140);
    // Carbs land close to target. Protein overshoots ~25% because the
    // carb role (bread) has real protein content of its own that isn't
    // subtracted back out of the protein role's sizing -- same known,
    // accepted directional limitation as composeSnack's greedy algorithm.
    // Fat lands well under target: by the time protein+carb are sized,
    // only ~5.7g of fat gap remains, needing ~5g of oil -- which rounds
    // BELOW MIN_INGREDIENT_AMOUNT_G (10g) and is correctly skipped rather
    // than force an amount too small to be a sensible real add-on (same
    // rule as addon.ts). A real, disclosed limitation of this specific
    // composition, not a bug -- comparable in size to deviations already
    // seen on real Spoonacular "closest match" picks elsewhere in this
    // pipeline.
    expect(meal!.ingredients.find((i) => i.ingredientName === "olive oil")).toBeUndefined();
    expect(meal!.totalProteinG).toBeCloseTo(38.5, 0);
    expect(meal!.totalCarbsG).toBeCloseTo(34.4, 0);
    expect(meal!.totalFatG).toBeCloseTo(4.1, 0);
  });

  it("rejects the whole composition when the chosen protein source needs an unrealistic portion (the tofu case)", async () => {
    // This is the exact failure mode found live July 15 2026: tofu isn't
    // protein-dense enough to hit this target within a realistic amount
    // (346g needed, over the 280g bound), and that much tofu ALSO already
    // overshoots the fat target -- the portion bound must reject this
    // outright rather than serve either problem.
    const proposal: MealProposal = {
      dishName: "Tofu Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "firm tofu", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "firm tofu": tofu, "whole wheat bread": bread, "olive oil": oil });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(meal).toBeNull();
  });

  // Audit item #4, live-confirmed 2026-07-22 (stacked-safety
  // re-verification): avocado's real ~14.7g fat/100g density needed 70g to
  // close even a modest ~10g fat gap -- the old 40g cap rejected the WHOLE
  // dish for this, even though 70g avocado is an entirely ordinary amount
  // (well under a single whole avocado's typical edible weight). Raised
  // to 150g.
  it("allows a less-concentrated fat source (avocado) to size past the old 40g cap, within the new 150g one", async () => {
    const zeroFatProtein: GroundedIngredientData = { id: 2, name: "zero fat protein", caloriesPer100g: 120, proteinGPer100g: 30, carbsGPer100g: 0, fatGPer100g: 0, estimatedCostCentsPer100g: null };
    const zeroFatCarb: GroundedIngredientData = { id: 3, name: "zero fat carb", caloriesPer100g: 90, proteinGPer100g: 0, carbsGPer100g: 25, fatGPer100g: 0, estimatedCostCentsPer100g: null };
    const target = { calories: 400, proteinG: 25, carbsG: 40, fatG: 10.3 };
    const proposal: MealProposal = {
      dishName: "Avocado Toast Bowl",
      ingredients: [
        { name: "zero fat protein", role: "protein" },
        { name: "zero fat carb", role: "carb" },
        { name: "avocado", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "zero fat protein": zeroFatProtein, "zero fat carb": zeroFatCarb, avocado });
    const meal = await composeMealFromProposal(proposal, target, NONE, fetcher);
    expect(meal).not.toBeNull();
    const avocadoItem = meal!.ingredients.find((i) => i.ingredientName === "avocado")!;
    expect(avocadoItem.amountG).toBeGreaterThan(40);
    expect(avocadoItem.amountG).toBeLessThanOrEqual(150);
  });

  it("still rejects a genuinely oversized amount of a concentrated fat source, even at the widened 150g cap", async () => {
    const zeroFatProtein: GroundedIngredientData = { id: 2, name: "zero fat protein", caloriesPer100g: 120, proteinGPer100g: 30, carbsGPer100g: 0, fatGPer100g: 0, estimatedCostCentsPer100g: null };
    const zeroFatCarb: GroundedIngredientData = { id: 3, name: "zero fat carb", caloriesPer100g: 90, proteinGPer100g: 0, carbsGPer100g: 25, fatGPer100g: 0, estimatedCostCentsPer100g: null };
    const target = { calories: 2200, proteinG: 25, carbsG: 40, fatG: 200 };
    const proposal: MealProposal = {
      dishName: "Absurd Oil Bowl",
      ingredients: [
        { name: "zero fat protein", role: "protein" },
        { name: "zero fat carb", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "zero fat protein": zeroFatProtein, "zero fat carb": zeroFatCarb, "olive oil": oil });
    const meal = await composeMealFromProposal(proposal, target, NONE, fetcher);
    expect(meal).toBeNull();
  });

  it("rejects the whole composition when any ingredient is unsafe for the profile", async () => {
    const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
    const proposal: MealProposal = {
      dishName: "Chicken and Rice Bowl",
      ingredients: [
        { name: "grilled chicken breast", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "grilled chicken breast": chicken, "whole wheat bread": bread, "olive oil": oil });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, ctx, fetcher);
    // Safety check must reject BEFORE any grounding call for the unsafe item.
    expect(meal).toBeNull();
    expect(fetcher).not.toHaveBeenCalledWith("grilled chicken breast");
  });

  it("rejects a malformed proposal missing a required role", async () => {
    const proposal: MealProposal = {
      dishName: "Incomplete Dish",
      ingredients: [{ name: "seitan cutlets", role: "protein" }],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(meal).toBeNull();
  });

  // Comprehensive engine test, July 16 2026: a proposal with two
  // ingredients for the same role used to silently drop the second one
  // entirely (Array.find only ever returns the first match) -- no error,
  // no rejection, just an incomplete meal with undercounted macros.
  it("rejects a proposal with two ingredients claiming the same role, rather than silently dropping the second", async () => {
    const proposal: MealProposal = {
      dishName: "Double Protein Bowl",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "grilled chicken breast", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "grilled chicken breast": chicken, "whole wheat bread": bread, "olive oil": oil });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(meal).toBeNull();
    // Confirms this is rejected up front -- nothing is even looked up,
    // not just absent from the (rejected) result.
    expect(fetcher).not.toHaveBeenCalled();
  });

  // Comprehensive engine test, July 16 2026: `amountG < min || amountG >
  // max` is FALSE for NaN (every NaN comparison is false), so a NaN
  // fixedAmountG used to silently pass the realism check where Infinity
  // was already correctly caught.
  it("rejects a NaN fixed portion amount, where Infinity was already correctly caught", async () => {
    const proposal: MealProposal = {
      dishName: "NaN Garnish Bowl",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
        { name: "spinach", role: "fixed", fixedAmountG: NaN },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "whole wheat bread": bread, "olive oil": oil, spinach });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(meal).toBeNull();
  });

  // Found live 2026-07-21 (thin-corpus AI-compose investigation): fixedAmountG
  // is optional in both the tool schema and the prompt's own wording, so a
  // real Claude proposal routinely omits it for a garnish/side item. That
  // used to default to 0, which fails isRealisticAmount's 5g floor and
  // silently rejected an otherwise-perfect composition -- reproduced here
  // with the exact same fixture as the passing "well-portioned dish" test
  // above, just with the fixed item's amount omitted.
  it("still composes when a fixed-role item omits fixedAmountG, using a realistic default", async () => {
    const proposal: MealProposal = {
      dishName: "Seitan Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
        { name: "spinach", role: "fixed" },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "whole wheat bread": bread, "olive oil": oil, spinach });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(meal).not.toBeNull();
    const spinachItem = meal!.ingredients.find((i) => i.ingredientName === "spinach")!;
    expect(spinachItem.amountG).toBe(40);
  });

  // Found live 2026-07-21, same investigation: a fixed item's name
  // sometimes doesn't resolve via the grounding lookup at all (e.g.
  // "steamed broccoli florets" returned no match live). Same class of bug
  // as the missing-fixedAmountG case above -- a fixed item is never
  // load-bearing for the macro target, so a failed lookup should drop that
  // one garnish, not reject an otherwise-good protein/carb/fat solve.
  it("still composes when a fixed-role item's name doesn't resolve via the grounding lookup", async () => {
    const proposal: MealProposal = {
      dishName: "Seitan Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
        { name: "steamed broccoli florets", role: "fixed", fixedAmountG: 80 },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "whole wheat bread": bread, "olive oil": oil });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(meal).not.toBeNull();
    expect(meal!.ingredients.find((i) => i.ingredientName === "steamed broccoli florets")).toBeUndefined();
  });

  // Found live 2026-07-21, same investigation: this role's own prompt
  // description explicitly allows "a spice" alongside "a vegetable side, a
  // garnish" -- but the 5g floor rejected a genuinely realistic spice
  // amount (2g of smoked paprika, a normal seasoning quantity), sinking an
  // otherwise-good composition for being too small, not too large. Floor
  // lowered to 1g; max (150g) is unchanged and still catches an
  // oversized garnish.
  it("still composes when a fixed-role item has a realistic spice-scale amount below the old 5g floor", async () => {
    const proposal: MealProposal = {
      dishName: "Seitan Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
        { name: "smoked paprika", role: "fixed", fixedAmountG: 2 },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "whole wheat bread": bread, "olive oil": oil, "smoked paprika": paprika });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(meal).not.toBeNull();
    const paprikaItem = meal!.ingredients.find((i) => i.ingredientName === "smoked paprika")!;
    expect(paprikaItem.amountG).toBe(2);
  });

  // Protein/carb/fat lookup failures are unlike fixed-item ones -- these
  // roles ARE load-bearing for the macro target, so they must still reject
  // rather than silently drop (a missing protein source can't just be
  // skipped the way a garnish can).
  it("rejects when an ingredient doesn't resolve via the grounding lookup", async () => {
    const proposal: MealProposal = {
      dishName: "Mystery Dish",
      ingredients: [
        { name: "unobtainium protein", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "whole wheat bread": bread, "olive oil": oil });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(meal).toBeNull();
  });

  it("allows the fat role to contribute nothing without rejecting, same as composeSnack's behavior", async () => {
    // If protein+carb already cover the fat target, the fat ingredient
    // should simply be omitted, not force an unrealistic near-zero amount.
    const highFatProtein: GroundedIngredientData = { id: 2, name: "high fat protein", caloriesPer100g: 200, proteinGPer100g: 25, carbsGPer100g: 0, fatGPer100g: 15, estimatedCostCentsPer100g: null };
    const proposal: MealProposal = {
      dishName: "Rich Bowl",
      ingredients: [
        { name: "high fat protein", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "high fat protein": highFatProtein, "whole wheat bread": bread, "olive oil": oil });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(meal).not.toBeNull();
    expect(meal!.ingredients.find((i) => i.ingredientName === "olive oil")).toBeUndefined();
  });

  it("allows the carb role to contribute nothing without rejecting, when an earlier role already covers the carb target", async () => {
    // Live-confirmed 2026-07-21 (stacked-safety investigation): a
    // carb-heavy protein source (lentils/beans/chickpeas, common once
    // dairy/soy/nuts/eggs are all excluded) can already cover the carb
    // target on its own -- this used to hard-reject the WHOLE dish
    // instead of just omitting the now-redundant carb ingredient, the
    // same class of bug already fixed for the fat role above.
    const carbHeavyProtein: GroundedIngredientData = { id: 3, name: "carb-heavy protein", caloriesPer100g: 300, proteinGPer100g: 25, carbsGPer100g: 40, fatGPer100g: 0, estimatedCostCentsPer100g: null };
    const proposal: MealProposal = {
      dishName: "Lentil Bowl",
      ingredients: [
        { name: "carb-heavy protein", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "carb-heavy protein": carbHeavyProtein, "whole wheat bread": bread, "olive oil": oil });
    const meal = await composeMealFromProposal(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(meal).not.toBeNull();
    expect(meal!.ingredients.find((i) => i.ingredientName === "whole wheat bread")).toBeUndefined();
  });
});

// Retry-with-feedback (2026-07-30): composeMealFromProposalDetailed tags
// WHY a rejection happened instead of a bare null. These reuse the exact
// same fixtures/scenarios as the toBeNull() cases above -- the null/
// non-null pattern is unchanged (verified above), this only checks the
// reason attached to each rejection is the right one.
describe("composeMealFromProposalDetailed", () => {
  it("tags an unrealistic protein portion as portion_out_of_bounds on the protein role (the tofu case)", async () => {
    const proposal: MealProposal = {
      dishName: "Tofu Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "firm tofu", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "firm tofu": tofu, "whole wheat bread": bread, "olive oil": oil });
    const result = await composeMealFromProposalDetailed(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason.kind).toBe("portion_out_of_bounds");
    expect(result.reason).toMatchObject({ role: "protein", ingredientName: "firm tofu" });
  });

  it("tags a missing role as missing_role, naming the specific missing role", async () => {
    const proposal: MealProposal = {
      dishName: "Incomplete Dish",
      ingredients: [{ name: "seitan cutlets", role: "protein" }],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan });
    const result = await composeMealFromProposalDetailed(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toEqual({ kind: "missing_role", role: "carb" });
  });

  it("tags a duplicate role as duplicate_role, naming the role", async () => {
    const proposal: MealProposal = {
      dishName: "Double Protein Bowl",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "grilled chicken breast", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "grilled chicken breast": chicken, "whole wheat bread": bread, "olive oil": oil });
    const result = await composeMealFromProposalDetailed(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toEqual({ kind: "duplicate_role", role: "protein" });
  });

  it("tags an unsafe ingredient as unsafe_ingredient, carrying the real safety-gate reason string", async () => {
    const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
    const proposal: MealProposal = {
      dishName: "Chicken and Rice Bowl",
      ingredients: [
        { name: "grilled chicken breast", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "grilled chicken breast": chicken, "whole wheat bread": bread, "olive oil": oil });
    const result = await composeMealFromProposalDetailed(proposal, BREAKFAST_TARGET, ctx, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason.kind).toBe("unsafe_ingredient");
    expect(result.reason).toMatchObject({ role: "protein", ingredientName: "grilled chicken breast" });
  });

  it("tags a failed grounding lookup as ingredient_not_found, naming the role and ingredient", async () => {
    const proposal: MealProposal = {
      dishName: "Mystery Dish",
      ingredients: [
        { name: "unobtainium protein", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "whole wheat bread": bread, "olive oil": oil });
    const result = await composeMealFromProposalDetailed(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toEqual({ kind: "ingredient_not_found", role: "protein", ingredientName: "unobtainium protein" });
  });

  it("still returns ok:true with the composed meal on success, wrapping the same result composeMealFromProposal returns", async () => {
    const proposal: MealProposal = {
      dishName: "Seitan Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
        { name: "spinach", role: "fixed", fixedAmountG: 40 },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "whole wheat bread": bread, "olive oil": oil, spinach });
    const result = await composeMealFromProposalDetailed(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.meal.dishName).toBe("Seitan Scramble with Spinach and Whole Wheat Toast");
  });
});

describe("describeRejectionForFeedback", () => {
  const cases: CompositionRejection[] = [
    { kind: "no_ingredients" },
    { kind: "unsafe_ingredient", role: "protein", ingredientName: "tempeh", reason: "contains soy, an allergen" },
    { kind: "duplicate_role", role: "protein" },
    { kind: "missing_role", role: "fat" },
    { kind: "fixed_item_unrealistic", ingredientName: "parsley", amountG: 0, min: 1, max: 150 },
    { kind: "ingredient_not_found", role: "carb", ingredientName: "unobtainium grain" },
    { kind: "portion_infeasible", role: "protein", ingredientName: "lentils", gapNeeded: 40 },
    { kind: "portion_out_of_bounds", role: "protein", ingredientName: "firm tofu", amountG: 346, min: 20, max: 280, gapNeeded: 30.8 },
  ];

  it.each(cases)("returns a non-empty, specific sentence for kind=%s", (reason) => {
    const sentence = describeRejectionForFeedback(reason);
    expect(sentence.length).toBeGreaterThan(10);
    if ("ingredientName" in reason) expect(sentence).toContain(reason.ingredientName);
    if ("role" in reason) expect(sentence).toContain(reason.role);
  });

  it("names the over-cap direction and the cap value for a too-large portion", () => {
    const sentence = describeRejectionForFeedback({
      kind: "portion_out_of_bounds",
      role: "protein",
      ingredientName: "firm tofu",
      amountG: 346,
      min: 20,
      max: 280,
      gapNeeded: 30.8,
    });
    expect(sentence).toContain("280g");
    expect(sentence).toContain("over");
  });
});

// "Fill with the closest meal rather than leaving it open" (2026-07-30,
// Satya's explicit request). The one non-negotiable constraint carried
// over from the strict composer: an unsafe ingredient must NEVER be
// relaxed into a shown result, under any circumstance. Every other
// rejection kind should degrade to an approximate-but-shown result
// instead of failing.
describe("composeMealFromProposalBestEffort", () => {
  it("CRITICAL: still rejects an unsafe ingredient -- safety is never relaxed, even as a last resort", async () => {
    const ctx: DietaryContext = { dietaryStyles: ["vegetarian"], allergies: [], dislikes: [] };
    const proposal: MealProposal = {
      dishName: "Chicken and Rice Bowl",
      ingredients: [
        { name: "grilled chicken breast", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "grilled chicken breast": chicken, "whole wheat bread": bread, "olive oil": oil });
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, ctx, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason.kind).toBe("unsafe_ingredient");
    // Confirms the safety check runs BEFORE any ingredient is looked up,
    // same as the strict composer -- no grounding call for the unsafe item.
    expect(fetcher).not.toHaveBeenCalledWith("grilled chicken breast");
  });

  it("still rejects when there is genuinely nothing to build from (no ingredients at all)", async () => {
    const proposal: MealProposal = { dishName: "Empty Dish", ingredients: [] };
    const fetcher = lookupFrom({});
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason.kind).toBe("no_ingredients");
  });

  it("succeeds with isApproximate:false when the proposal is actually fine -- never falsely discloses a compromise", async () => {
    const proposal: MealProposal = {
      dishName: "Seitan Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
        { name: "spinach", role: "fixed", fixedAmountG: 40 },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "whole wheat bread": bread, "olive oil": oil, spinach });
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.isApproximate).toBe(false);
    expect(result.result.approximationNotes).toEqual([]);
  });

  it("relaxes a duplicate role by keeping only the first ingredient, instead of rejecting", async () => {
    const proposal: MealProposal = {
      dishName: "Double Protein Bowl",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "grilled chicken breast", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "grilled chicken breast": chicken, "whole wheat bread": bread, "olive oil": oil });
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.isApproximate).toBe(true);
    expect(result.result.meal.ingredients.find((i) => i.ingredientName === "seitan cutlets")).toBeDefined();
    expect(result.result.meal.ingredients.find((i) => i.ingredientName === "grilled chicken breast")).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalledWith("grilled chicken breast");
  });

  it("relaxes a missing role to a lighter-on-that-macro meal, instead of rejecting", async () => {
    const proposal: MealProposal = {
      dishName: "Incomplete Dish",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "whole wheat bread": bread });
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.isApproximate).toBe(true);
    expect(result.result.meal.ingredients).toHaveLength(2);
  });

  it("relaxes a fixed item's unrealistic amount by clamping it, instead of rejecting the whole dish", async () => {
    const proposal: MealProposal = {
      dishName: "Seitan Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
        { name: "spinach", role: "fixed", fixedAmountG: 500 }, // way over the 150g cap
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "whole wheat bread": bread, "olive oil": oil, spinach });
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.isApproximate).toBe(true);
    const spinachItem = result.result.meal.ingredients.find((i) => i.ingredientName === "spinach")!;
    expect(spinachItem.amountG).toBe(150); // clamped to the realistic max, not rejected
  });

  it("drops a role whose ingredient can't be grounded, instead of rejecting the whole dish (the tofu-style unobtainium case)", async () => {
    const proposal: MealProposal = {
      dishName: "Mystery Dish",
      ingredients: [
        { name: "unobtainium protein", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "whole wheat bread": bread, "olive oil": oil });
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.isApproximate).toBe(true);
    expect(result.result.meal.ingredients.find((i) => i.ingredientName === "unobtainium protein")).toBeUndefined();
    // Carb (bread) succeeds; fat (oil) rounds to 5g against the now-larger
    // remaining fat gap (protein contributed nothing) -- below the 10g
    // floor, so it's correctly skipped too (fat is optional, same as the
    // strict composer's own "allowed to contribute nothing" exception,
    // not a second compromise to report). Just the one real ingredient.
    expect(result.result.meal.ingredients.find((i) => i.ingredientName === "whole wheat bread")).toBeDefined();
  });

  it("clamps an out-of-bounds portion (the tofu case) to a realistic amount, instead of rejecting", async () => {
    // Same fixture as the strict composer's rejection test: 346g tofu
    // needed to close the full protein gap, over the 280g cap.
    const proposal: MealProposal = {
      dishName: "Tofu Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "firm tofu", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "firm tofu": tofu, "whole wheat bread": bread, "olive oil": oil });
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.isApproximate).toBe(true);
    const tofuItem = result.result.meal.ingredients.find((i) => i.ingredientName === "firm tofu")!;
    expect(tofuItem.amountG).toBe(280); // clamped to the realistic max, not rejected
  });

  it("falls back to a realistic minimum portion when a role can't be sized at all (zero-density or non-positive gap)", async () => {
    const zeroProteinDensity: GroundedIngredientData = { id: 99, name: "zero density protein", caloriesPer100g: 50, proteinGPer100g: 0, carbsGPer100g: 5, fatGPer100g: 1, estimatedCostCentsPer100g: null };
    const proposal: MealProposal = {
      dishName: "Odd Dish",
      ingredients: [
        { name: "zero density protein", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "zero density protein": zeroProteinDensity, "whole wheat bread": bread, "olive oil": oil });
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.isApproximate).toBe(true);
    const item = result.result.meal.ingredients.find((i) => i.ingredientName === "zero density protein")!;
    expect(item.amountG).toBe(20); // PORTION_BOUNDS_G.protein.min
  });

  it("still rejects when every single ingredient fails to resolve -- nothing real to show", async () => {
    const proposal: MealProposal = {
      dishName: "All Unobtainium Dish",
      ingredients: [
        { name: "unobtainium protein", role: "protein" },
        { name: "unobtainium carb", role: "carb" },
        { name: "unobtainium fat", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({});
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection despite best-effort mode");
    expect(result.reason.kind).toBe("ingredient_not_found");
  });
});
