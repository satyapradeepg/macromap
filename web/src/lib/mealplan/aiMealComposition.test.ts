import { describe, it, expect, vi } from "vitest";
import {
  composeMealFromProposal,
  composeMealFromProposalDetailed,
  composeMealFromProposalBestEffort,
  composeMealFromEditDetailed,
  isNoOpEdit,
  describeRejectionForFeedback,
  describeRejectionForChatUser,
  findTitleIngredientMismatch,
  stripAllTitleMismatches,
  type CompositionRejection,
  type ComposedMeal,
  type GroundedIngredientData,
  type MealEditProposal,
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
// Live-fetched via Spoonacular's own ingredient database (2026-07-31,
// finding #5 follow-up) -- id 1033. Real carb density (3.22g/100g) is
// near-zero; protein/fat are what actually dominate this food.
const parmesan: GroundedIngredientData = { id: 1033, name: "parmesan cheese", caloriesPer100g: 392, proteinGPer100g: 35.75, carbsGPer100g: 3.22, fatGPer100g: 25.83, estimatedCostCentsPer100g: null };

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
    // 100g, not the naive sequential solve's 140g -- refineRoleAmounts
    // (aiMealComposition.ts) corrects seitan's amount downward once bread's
    // own ~12g protein/100g is counted, instead of sizing protein against
    // the full target and never revisiting it. Verified by hand: this
    // converges in one refinement round (a second round reproduces the
    // same 100g/70g exactly, confirming a stable fixed point).
    expect(seitanItem.amountG).toBe(100);
    // Protein now lands almost exactly on target (was 38.5, +25% over,
    // before this refinement pass existed). By the time protein+carb are
    // sized, the remaining fat gap needs only ~5g of oil -- a completely
    // normal real amount (a teaspoon is ~4.5g), and now included: sizeForGap
    // is passed PORTION_BOUNDS_G.fat.min (3g) at this call site instead of
    // the universal MIN_INGREDIENT_AMOUNT_G (10g), which used to silently
    // drop this same real, non-negligible amount before this fix (found
    // live 2026-08-01 auditing fat under-delivery -- PORTION_BOUNDS_G.fat's
    // own documented 3g floor had been unreachable dead code for this exact
    // reason since it was set).
    const oilItem = meal!.ingredients.find((i) => i.ingredientName === "olive oil");
    expect(oilItem).toBeDefined();
    expect(oilItem!.amountG).toBe(5);
    expect(meal!.totalProteinG).toBeCloseTo(30.75, 1);
    expect(meal!.totalCarbsG).toBeCloseTo(35.1, 1);
    expect(meal!.totalFatG).toBeCloseTo(8.8, 1);
  });

  // Isolated fat-floor boundary check (2026-08-01) -- pure single-macro
  // fixtures (zero cross-contamination) so the fat gap at oil's turn is
  // exactly target.fatG, no refineRoleAmounts interaction to account for.
  it("includes a small-but-real fat amount (3-9g) the universal 10g floor used to silently drop", async () => {
    const pureProtein: GroundedIngredientData = { id: 1, name: "pure protein", caloriesPer100g: 400, proteinGPer100g: 100, carbsGPer100g: 0, fatGPer100g: 0, estimatedCostCentsPer100g: null };
    const pureCarb: GroundedIngredientData = { id: 2, name: "pure carb", caloriesPer100g: 400, proteinGPer100g: 0, carbsGPer100g: 100, fatGPer100g: 0, estimatedCostCentsPer100g: null };
    const proposal: MealProposal = {
      dishName: "Test Dish",
      ingredients: [
        { name: "pure protein", role: "protein" },
        { name: "pure carb", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    // 6g fat gap -> oil (100g fat/100g) needs 6g, floored to nearest 5g = 5g
    // -- above fat's own 3g floor, below the universal 10g one this fixes.
    const target = { calories: 300, proteinG: 20, carbsG: 20, fatG: 6 };
    const fetcher = lookupFrom({ "pure protein": pureProtein, "pure carb": pureCarb, "olive oil": oil });
    const meal = await composeMealFromProposal(proposal, target, NONE, fetcher);
    expect(meal).not.toBeNull();
    const oilItem = meal!.ingredients.find((i) => i.ingredientName === "olive oil");
    expect(oilItem).toBeDefined();
    expect(oilItem!.amountG).toBe(5);
  });

  it("still correctly drops fat when the gap is genuinely negligible, below fat's own 3g floor", async () => {
    const pureProtein: GroundedIngredientData = { id: 1, name: "pure protein", caloriesPer100g: 400, proteinGPer100g: 100, carbsGPer100g: 0, fatGPer100g: 0, estimatedCostCentsPer100g: null };
    const pureCarb: GroundedIngredientData = { id: 2, name: "pure carb", caloriesPer100g: 400, proteinGPer100g: 0, carbsGPer100g: 100, fatGPer100g: 0, estimatedCostCentsPer100g: null };
    const proposal: MealProposal = {
      dishName: "Test Dish",
      ingredients: [
        { name: "pure protein", role: "protein" },
        { name: "pure carb", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    // 2g fat gap -> even at oil's 100g/100g density, 2g floors to 0 -- below
    // PORTION_BOUNDS_G.fat.min (3g) too, so this stays a genuine drop, not
    // a regression of the fix above.
    const target = { calories: 300, proteinG: 20, carbsG: 20, fatG: 2 };
    const fetcher = lookupFrom({ "pure protein": pureProtein, "pure carb": pureCarb, "olive oil": oil });
    const meal = await composeMealFromProposal(proposal, target, NONE, fetcher);
    expect(meal).not.toBeNull();
    expect(meal!.ingredients.find((i) => i.ingredientName === "olive oil")).toBeUndefined();
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
      dishName: "Chicken and Bread Bowl",
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
      dishName: "Hearty Bowl",
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
      dishName: "Chicken and Bread Bowl",
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

  it("tags a title/ingredient mismatch as title_ingredient_mismatch, before any grounding call", async () => {
    // Live-confirmed 2026-08-01: a dish titled "...with Rice" whose real
    // ingredients never included rice at all -- same bug class as the
    // persona audit's finding #6, just with the model's own
    // titleIngredientCheck self-check (mealProposer.ts) having failed
    // silently again.
    const proposal: MealProposal = {
      dishName: "Spinach and Chickpea Curry with Rice",
      ingredients: [
        { name: "chickpeas", role: "protein" },
        { name: "olive oil", role: "fat" },
        { name: "spinach", role: "fixed", fixedAmountG: 40 },
      ],
    };
    const fetcher = lookupFrom({ chickpeas: seitan, "olive oil": oil, spinach });
    const result = await composeMealFromProposalDetailed(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toEqual({
      kind: "title_ingredient_mismatch",
      dishName: "Spinach and Chickpea Curry with Rice",
      mismatchedWord: "rice",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("catches a title/ingredient mismatch that only appears AFTER a fixed ingredient silently fails its lookup and gets dropped", async () => {
    // Live-confirmed 2026-08-01: a dish titled "...Brown Bean Buddha
    // Bowl..." shipped with no bean anywhere -- the proposal's "black
    // beans" fixed-role item passed the EARLY title check fine (it WAS in
    // the proposal at that point), then failed its Spoonacular lookup a
    // few lines later and was silently dropped (the fixed-item loop's own
    // deliberate "don't reject a whole good dish over one ungroundable
    // garnish" rule) -- orphaning the title's "Bean" reference. This test
    // reproduces that exact shape: "black beans" is proposed but the
    // fetcher has no entry for it, so it's the only fixed item to be
    // dropped, and the final composed ingredients (seitan, brown rice,
    // olive oil) genuinely have no bean anywhere.
    const proposal: MealProposal = {
      dishName: "Seitan and Brown Bean Buddha Bowl with Rice",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "brown rice", role: "carb" },
        { name: "olive oil", role: "fat" },
        { name: "black beans", role: "fixed", fixedAmountG: 40 },
      ],
    };
    const rice: GroundedIngredientData = { id: 2, name: "brown rice", caloriesPer100g: 112, proteinGPer100g: 2.6, carbsGPer100g: 23.5, fatGPer100g: 0.9, estimatedCostCentsPer100g: null };
    // "black beans" deliberately has no entry -- lookupFrom returns null,
    // reproducing the real silent-drop path.
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "brown rice": rice, "olive oil": oil });
    const result = await composeMealFromProposalDetailed(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toEqual({
      kind: "title_ingredient_mismatch",
      dishName: "Seitan and Brown Bean Buddha Bowl with Rice",
      mismatchedWord: "bean",
    });
    // Confirms the drop really happened (not skipped/short-circuited) --
    // the lookup WAS attempted for the fixed item before it was dropped.
    expect(fetcher).toHaveBeenCalledWith("black beans");
  });
});

describe("findTitleIngredientMismatch", () => {
  it("returns null when every specific-ingredient word in the title is backed by a real ingredient", () => {
    const result = findTitleIngredientMismatch("Seitan Stir-Fry with Brown Rice and Peas", [
      { name: "seitan cutlets" },
      { name: "brown rice" },
      { name: "sesame oil" },
      { name: "petite peas" },
    ]);
    expect(result).toBeNull();
  });

  it("catches the live-confirmed 'Tofu Steak' case with no tofu in the ingredients at all", () => {
    const result = findTitleIngredientMismatch("Pea Protein Crusted Tofu Steak with Mashed Sweet Potato", [
      { name: "spinach" },
      { name: "pea protein powder" },
      { name: "sweet potato" },
    ]);
    expect(result).toBe("tofu");
  });

  it("catches the live-confirmed '...with Quinoa' case with no quinoa in the ingredients", () => {
    const result = findTitleIngredientMismatch("Tempeh and Kale Skillet with Quinoa", [
      { name: "kale" },
      { name: "garlic" },
      { name: "tempeh" },
    ]);
    expect(result).toBe("quinoa");
  });

  it("handles the irregular potato/potatoes plural in both directions", () => {
    expect(findTitleIngredientMismatch("Roasted Potatoes Bowl", [{ name: "russet potato" }])).toBeNull();
    expect(findTitleIngredientMismatch("Potato Bowl", [{ name: "russet potatoes" }])).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(findTitleIngredientMismatch("TOFU Scramble", [{ name: "Firm Tofu" }])).toBeNull();
  });

  it("does not flag common preparation/style words that aren't in the curated list (e.g. 'toast', 'steak', 'bowl')", () => {
    // "toast" describes a PREPARATION of bread, not a separate ingredient
    // -- live-confirmed this exact combination is a normal, correct dish
    // (found while adding this check: it initially false-flagged this
    // codebase's own long-standing "Seitan Scramble with Spinach and
    // Whole Wheat Toast" test fixture, whose carb ingredient is
    // legitimately named "whole wheat bread", not "toast").
    const result = findTitleIngredientMismatch("Seitan Scramble with Spinach and Whole Wheat Toast", [
      { name: "seitan cutlets" },
      { name: "whole wheat bread" },
      { name: "olive oil" },
      { name: "spinach" },
    ]);
    expect(result).toBeNull();
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
    { kind: "title_ingredient_mismatch", dishName: "Curry with Rice", mismatchedWord: "rice" },
  ];

  it.each(cases)("returns a non-empty, specific sentence for kind=%s", (reason) => {
    const sentence = describeRejectionForFeedback(reason);
    expect(sentence.length).toBeGreaterThan(10);
    if ("ingredientName" in reason) expect(sentence).toContain(reason.ingredientName);
    if ("role" in reason) expect(sentence).toContain(reason.role);
    if ("mismatchedWord" in reason) expect(sentence).toContain(reason.mismatchedWord);
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
      dishName: "Chicken and Bread Bowl",
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
    // Same fixture as composeMealFromProposal's protein-accuracy test above
    // -- confirms the same refineRoleAmounts correction applies here too
    // (100g seitan / ~30.75g protein, not the naive sequential solve's
    // 140g / 38.5g), silently, with no approximation note needed since
    // refining sizing math isn't a compromise the user needs disclosed.
    const seitanItem = result.result.meal.ingredients.find((i) => i.ingredientName === "seitan cutlets")!;
    expect(seitanItem.amountG).toBe(100);
    expect(result.result.meal.totalProteinG).toBeCloseTo(30.75, 1);
    // Also picks up the fat-floor fix (sizeForGap now passed
    // PORTION_BOUNDS_G.fat.min=3 at this call site too, via
    // relaxedRoleItem's rescue retry) -- olive oil's ~5g gap used to be
    // silently dropped by the universal 10g floor, now correctly included.
    const oilItem = result.result.meal.ingredients.find((i) => i.ingredientName === "olive oil");
    expect(oilItem).toBeDefined();
    expect(oilItem!.amountG).toBe(5);
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

  // Persona audit 2026-07-31, finding #5 follow-up: live-confirmed a real
  // generation produced a 1308-cal/68g-fat outlier lunch from Claude
  // proposing parmesan cheese (3.22g carb/100g -- essentially a
  // protein/fat food, not a carb source) as the "carb" role ingredient.
  // Unlike the tofu case just above (a genuinely close 1.24x-over near
  // miss, correctly still a clamp), this needs 1111g against the 250g
  // carb cap -- 4.4x over -- which should now route to the same "not
  // dense enough" honest degradation the zero-density case uses, not a
  // clamp that silently drags in ~980 incidental kcal from "the carb
  // ingredient" alone.
  it("falls back to a realistic minimum portion (not a clamp to max) when the proposed ingredient's density is drastically the wrong shape for its role", async () => {
    const proposal: MealProposal = {
      dishName: "Seitan and Parmesan Bowl",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "parmesan cheese", role: "carb" },
        { name: "olive oil", role: "fat" },
      ],
    };
    const fetcher = lookupFrom({ "seitan cutlets": seitan, "parmesan cheese": parmesan, "olive oil": oil });
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.isApproximate).toBe(true);
    const parmesanItem = result.result.meal.ingredients.find((i) => i.ingredientName === "parmesan cheese")!;
    expect(parmesanItem.amountG).toBe(15); // the carb role's realistic MINIMUM, not the 250g max
    // Confirms the outlier is actually gone: parmesan's own contribution
    // stays small instead of delivering ~980 incidental kcal at 250g.
    expect(parmesanItem.caloriesKcal).toBeLessThan(100);
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

  it("corrects a title left orphaned by its own role-dropping relaxation, and discloses the correction via approximationNotes", async () => {
    // Live-confirmed 2026-08-01, twice in one real generation: a dish
    // titled "Seitan and Kale Fried Rice..." shipped with no seitan (and
    // once, no kale either) -- best-effort's own tolerance for a missing
    // protein role (this file's "no protein ingredient was proposed" note
    // above) orphaned the title reference, with no mechanism to catch it
    // since best-effort can never reject and re-check the title the way
    // the strict composer's two checks do. Reproduces the exact shape:
    // "seitan cutlets" fails its lookup (dropped, matching this file's own
    // "couldn't be matched to real ingredient data" note), leaving the
    // title's "Seitan" reference with nothing backing it.
    const proposal: MealProposal = {
      dishName: "Seitan and Kale Fried Rice with Peas",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "brown rice", role: "carb" },
        { name: "sesame oil", role: "fat" },
        { name: "petite peas", role: "fixed", fixedAmountG: 40 },
      ],
    };
    const rice: GroundedIngredientData = { id: 2, name: "brown rice", caloriesPer100g: 112, proteinGPer100g: 2.6, carbsGPer100g: 23.5, fatGPer100g: 0.9, estimatedCostCentsPer100g: null };
    const peas: GroundedIngredientData = { id: 3, name: "petite peas", caloriesPer100g: 81, proteinGPer100g: 5.4, carbsGPer100g: 14.5, fatGPer100g: 0.4, estimatedCostCentsPer100g: null };
    const sesameOil: GroundedIngredientData = { id: 4, name: "sesame oil", caloriesPer100g: 884, proteinGPer100g: 0, carbsGPer100g: 0, fatGPer100g: 100, estimatedCostCentsPer100g: null };
    // "seitan cutlets" deliberately has no entry -- reproduces the real
    // failed-lookup-drop path (this file's `relaxedRoleItem`'s own
    // "couldn't be matched to real ingredient data and was dropped" note).
    const fetcher = lookupFrom({ "brown rice": rice, "petite peas": peas, "sesame oil": sesameOil });
    const result = await composeMealFromProposalBestEffort(proposal, BREAKFAST_TARGET, NONE, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.meal.dishName).toBe("Kale Fried Rice with Peas");
    expect(result.result.meal.dishName.toLowerCase()).not.toContain("seitan");
    expect(result.result.isApproximate).toBe(true);
    expect(result.result.approximationNotes.some((n) => n.includes('no longer mentions "seitan"'))).toBe(true);
  });
});

describe("stripAllTitleMismatches", () => {
  it("removes a single mismatched word and its adjacent 'and' connector", () => {
    const result = stripAllTitleMismatches("Seitan and Kale Fried Rice with Peas", [
      { name: "kale" },
      { name: "brown rice" },
      { name: "sesame oil" },
      { name: "petite peas" },
    ]);
    expect(result).toEqual({ dishName: "Kale Fried Rice with Peas", removedWords: ["seitan"] });
  });

  it("removes a trailing 'with X' clause entirely", () => {
    const result = stripAllTitleMismatches("Spinach and Chickpea Curry with Rice", [
      { name: "spinach" },
      { name: "chickpeas" },
    ]);
    expect(result).toEqual({ dishName: "Spinach and Chickpea Curry", removedWords: ["rice"] });
  });

  it("removes multiple mismatched words across repeated passes", () => {
    const result = stripAllTitleMismatches("Seitan and Bean Bowl with Rice", [{ name: "kale" }]);
    expect(result.dishName.toLowerCase()).not.toContain("seitan");
    expect(result.dishName.toLowerCase()).not.toContain("bean");
    expect(result.dishName.toLowerCase()).not.toContain("rice");
    expect(result.removedWords.sort()).toEqual(["bean", "rice", "seitan"]);
  });

  it("returns the title unchanged, with no removed words, when nothing is mismatched", () => {
    const result = stripAllTitleMismatches("Seitan Stir-Fry with Brown Rice and Peas", [
      { name: "seitan cutlets" },
      { name: "brown rice" },
      { name: "petite peas" },
    ]);
    expect(result).toEqual({ dishName: "Seitan Stir-Fry with Brown Rice and Peas", removedWords: [] });
  });

  it("still produces a readable (if imperfect) title when the mismatched word isn't adjacent to a connector", () => {
    // The real live-confirmed case: "Bean" sits between two other words
    // ("Brown" and "Buddha"), not next to "and"/"with" -- falls through to
    // the bare-word-removal fallback rather than the cleaner connector-aware
    // removal, and that's an accepted, disclosed tradeoff (see this
    // function's own comment), not a bug.
    const result = stripAllTitleMismatches("Seitan and Brown Bean Buddha Bowl with Quinoa", [
      { name: "kale" },
      { name: "seitan cutlets" },
      { name: "quinoa" },
      { name: "tahini" },
    ]);
    expect(result.dishName.toLowerCase()).not.toContain("bean");
    expect(result.dishName).not.toContain("  "); // no leftover double space
    expect(result.removedWords).toEqual(["bean"]);
  });
});

describe("composeMealFromEditDetailed", () => {
  it("grounds a valid edit -- explicit amounts, no target-solving", async () => {
    const fetchMacros = lookupFrom({ "seitan cutlets": seitan, "brown rice": { id: 2, name: "brown rice", caloriesPer100g: 112, proteinGPer100g: 2.6, carbsGPer100g: 23.5, fatGPer100g: 0.9, estimatedCostCentsPer100g: null }, "olive oil": oil });
    const edit: MealEditProposal = {
      dishName: "Seitan Stir-Fry with Rice",
      ingredients: [
        { name: "seitan cutlets", role: "protein", amountG: 150 },
        { name: "brown rice", role: "carb", amountG: 100 },
        { name: "olive oil", role: "fat", amountG: 10 },
      ],
      changeSummary: "Doubled the seitan.",
    };
    const result = await composeMealFromEditDetailed(edit, NONE, fetchMacros);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meal.ingredients).toHaveLength(3);
      expect(result.meal.ingredients[0]).toMatchObject({ ingredientName: "seitan cutlets", amountG: 150, role: "protein" });
      // 150g seitan @ 21g protein/100g = 31.5g -- exact linear scale, no solving involved
      expect(result.meal.ingredients[0].proteinG).toBeCloseTo(31.5, 1);
    }
  });

  it("CRITICAL: rejects an unsafe ingredient unconditionally, same as the strict/best-effort composers", async () => {
    const ctx: DietaryContext = { dietaryStyles: [], allergies: ["peanuts"], dislikes: [] };
    const fetchMacros = lookupFrom({ peanuts: { id: 99, name: "peanuts", caloriesPer100g: 567, proteinGPer100g: 25.8, carbsGPer100g: 16.1, fatGPer100g: 49.2, estimatedCostCentsPer100g: null } });
    const edit: MealEditProposal = {
      dishName: "Peanut Snack",
      ingredients: [{ name: "peanuts", role: "protein", amountG: 40 }],
      changeSummary: "Added peanuts.",
    };
    const result = await composeMealFromEditDetailed(edit, ctx, fetchMacros);
    expect(result).toEqual({ ok: false, reason: { kind: "unsafe_ingredient", role: "protein", ingredientName: "peanuts", reason: expect.any(String) } });
  });

  it("rejects a duplicate core role", async () => {
    const fetchMacros = lookupFrom({ "seitan cutlets": seitan, tofu: tofu });
    const edit: MealEditProposal = {
      dishName: "Two Proteins",
      ingredients: [
        { name: "seitan cutlets", role: "protein", amountG: 100 },
        { name: "tofu", role: "protein", amountG: 100 },
      ],
      changeSummary: "n/a",
    };
    const result = await composeMealFromEditDetailed(edit, NONE, fetchMacros);
    expect(result).toEqual({ ok: false, reason: { kind: "duplicate_role", role: "protein" } });
  });

  it("accepts an edit that drops a core role entirely -- the key edit-vs-generation divergence", async () => {
    // A fresh composition would reject this for missing carb/fat roles;
    // an edit legitimately can ("drop the rice from tonight's dinner").
    const fetchMacros = lookupFrom({ "seitan cutlets": seitan });
    const edit: MealEditProposal = {
      dishName: "Seitan Only",
      ingredients: [{ name: "seitan cutlets", role: "protein", amountG: 150 }],
      changeSummary: "Dropped the rice and oil.",
    };
    const result = await composeMealFromEditDetailed(edit, NONE, fetchMacros);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.meal.ingredients).toHaveLength(1);
  });

  it("rejects an explicit amount outside the role's realistic bounds, with the correct min/max payload", async () => {
    const fetchMacros = lookupFrom({ "seitan cutlets": seitan });
    const edit: MealEditProposal = {
      dishName: "Seitan Only",
      ingredients: [{ name: "seitan cutlets", role: "protein", amountG: 800 }],
      changeSummary: "Tripled the seitan.",
    };
    const result = await composeMealFromEditDetailed(edit, NONE, fetchMacros);
    expect(result).toEqual({
      ok: false,
      reason: { kind: "amount_out_of_bounds", role: "protein", ingredientName: "seitan cutlets", amountG: 800, min: 20, max: 280 },
    });
  });

  it("rejects a title/ingredient mismatch against the composed ingredients", async () => {
    const fetchMacros = lookupFrom({ "seitan cutlets": seitan });
    const edit: MealEditProposal = {
      dishName: "Seitan and Quinoa Bowl",
      ingredients: [{ name: "seitan cutlets", role: "protein", amountG: 150 }],
      changeSummary: "n/a",
    };
    const result = await composeMealFromEditDetailed(edit, NONE, fetchMacros);
    expect(result).toEqual({ ok: false, reason: { kind: "title_ingredient_mismatch", dishName: "Seitan and Quinoa Bowl", mismatchedWord: "quinoa" } });
  });

  it("rejects when an ingredient fails to ground", async () => {
    const fetchMacros = lookupFrom({});
    const edit: MealEditProposal = {
      dishName: "Mystery Meal",
      ingredients: [{ name: "unobtainium", role: "protein", amountG: 100 }],
      changeSummary: "n/a",
    };
    const result = await composeMealFromEditDetailed(edit, NONE, fetchMacros);
    expect(result).toEqual({ ok: false, reason: { kind: "ingredient_not_found", role: "protein", ingredientName: "unobtainium" } });
  });

  it("rejects an edit with no ingredients", async () => {
    const edit: MealEditProposal = { dishName: "Empty", ingredients: [], changeSummary: "n/a" };
    const result = await composeMealFromEditDetailed(edit, NONE, lookupFrom({}));
    expect(result).toEqual({ ok: false, reason: { kind: "no_ingredients" } });
  });
});

describe("isNoOpEdit", () => {
  const proposedMeal = (ingredients: Array<{ ingredientName: string; amountG: number }>): ComposedMeal => ({
    dishName: "n/a",
    ingredients: ingredients.map((i) => ({ ...i, spoonacularIngredientId: 1, caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, estimatedCostCents: null })),
    totalCalories: 0,
    totalProteinG: 0,
    totalCarbsG: 0,
    totalFatG: 0,
    totalEstimatedCostCents: null,
  });

  it("detects an identical list as a no-op regardless of order", () => {
    const current = [{ name: "seitan cutlets", amountG: 150 }, { name: "brown rice", amountG: 100 }];
    const proposed = proposedMeal([{ ingredientName: "Brown Rice", amountG: 100 }, { ingredientName: "Seitan Cutlets", amountG: 150 }]);
    expect(isNoOpEdit(current, proposed)).toBe(true);
  });

  it("treats a sub-tolerance amount difference as a no-op", () => {
    const current = [{ name: "seitan cutlets", amountG: 150 }];
    const proposed = proposedMeal([{ ingredientName: "seitan cutlets", amountG: 150.5 }]);
    expect(isNoOpEdit(current, proposed)).toBe(true);
  });

  it("treats an over-tolerance amount difference as a real change", () => {
    const current = [{ name: "seitan cutlets", amountG: 150 }];
    const proposed = proposedMeal([{ ingredientName: "seitan cutlets", amountG: 300 }]);
    expect(isNoOpEdit(current, proposed)).toBe(false);
  });

  it("treats a different ingredient count as a real change", () => {
    const current = [{ name: "seitan cutlets", amountG: 150 }];
    const proposed = proposedMeal([{ ingredientName: "seitan cutlets", amountG: 150 }, { ingredientName: "brown rice", amountG: 100 }]);
    expect(isNoOpEdit(current, proposed)).toBe(false);
  });

  it("is case/whitespace-insensitive on names", () => {
    const current = [{ name: "  Seitan Cutlets  ", amountG: 150 }];
    const proposed = proposedMeal([{ ingredientName: "seitan cutlets", amountG: 150 }]);
    expect(isNoOpEdit(current, proposed)).toBe(true);
  });
});

describe("describeRejectionForChatUser", () => {
  const cases: Array<[CompositionRejection, RegExp]> = [
    [{ kind: "no_ingredients" }, /didn't end up with any ingredients/],
    [{ kind: "unsafe_ingredient", role: "protein", ingredientName: "peanuts", reason: "matches excluded term \"peanuts\"" }, /can't do that/],
    [{ kind: "duplicate_role", role: "carb" }, /more than one carb/],
    [{ kind: "missing_role", role: "fat" }, /missing a fat ingredient/],
    [{ kind: "fixed_item_unrealistic", ingredientName: "parsley", amountG: 900, min: 1, max: 150 }, /realistic side\/garnish amount/],
    [{ kind: "ingredient_not_found", role: "protein", ingredientName: "unobtainium" }, /couldn't find real nutrition data/],
    [{ kind: "portion_infeasible", role: "protein", ingredientName: "lentils", gapNeeded: 40 }, /isn't dense enough/],
    [{ kind: "portion_out_of_bounds", role: "carb", ingredientName: "rice", amountG: 400, min: 15, max: 250, gapNeeded: 90 }, /unrealistic amount/],
    [{ kind: "title_ingredient_mismatch", dishName: "Quinoa Bowl", mismatchedWord: "quinoa" }, /not actually one of the ingredients/],
    [{ kind: "amount_out_of_bounds", role: "protein", ingredientName: "seitan", amountG: 800, min: 20, max: 280 }, /realistic max is 280g/],
  ];

  it.each(cases)("describes %j without leaking internal field names", (reason, expected) => {
    const text = describeRejectionForChatUser(reason);
    expect(text).toMatch(expected);
    expect(text).not.toMatch(/gapNeeded|kind:/);
  });
});
