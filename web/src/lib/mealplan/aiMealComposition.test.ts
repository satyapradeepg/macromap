import { describe, it, expect, vi } from "vitest";
import { composeMealFromProposal, type GroundedIngredientData, type MealProposal } from "./aiMealComposition";
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
});
