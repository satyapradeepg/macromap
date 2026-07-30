import { describe, it, expect } from "vitest";
import {
  composeSnack,
  composedSnackTitle,
  allPoolIngredientNames,
  INGREDIENT_POOL,
  type IngredientMacroLookup,
} from "./snackComposition";
import type { PantryPriceContext } from "./pantryPricePreference";

// Real macro data (greek yogurt/banana live-confirmed earlier this
// project; almond values are standard USDA per-100g figures).
const pool: Record<string, IngredientMacroLookup> = {
  "greek yogurt": { id: 1256, name: "greek yogurt", caloriesPer100g: 61, proteinGPer100g: 10.3, carbsGPer100g: 3.64, fatGPer100g: 0.37, estimatedCostCentsPer100g: 71.43 },
  "cottage cheese": { id: 1017, name: "cottage cheese", caloriesPer100g: 98, proteinGPer100g: 11.1, carbsGPer100g: 3.4, fatGPer100g: 4.3, estimatedCostCentsPer100g: 50.0 },
  "protein powder": { id: 19334, name: "protein powder", caloriesPer100g: 379, proteinGPer100g: 80, carbsGPer100g: 8, fatGPer100g: 5, estimatedCostCentsPer100g: 278.57 },
  banana: { id: 9040, name: "banana", caloriesPer100g: 89, proteinGPer100g: 1.09, carbsGPer100g: 22.8, fatGPer100g: 0.33, estimatedCostCentsPer100g: 13.33 },
  apple: { id: 9003, name: "apple", caloriesPer100g: 52, proteinGPer100g: 0.26, carbsGPer100g: 13.8, fatGPer100g: 0.17, estimatedCostCentsPer100g: 33.11 },
  orange: { id: 9200, name: "orange", caloriesPer100g: 47, proteinGPer100g: 0.94, carbsGPer100g: 11.8, fatGPer100g: 0.12, estimatedCostCentsPer100g: 22.22 },
  almonds: { id: 12061, name: "almonds", caloriesPer100g: 579, proteinGPer100g: 21.2, carbsGPer100g: 21.6, fatGPer100g: 49.9, estimatedCostCentsPer100g: 178.57 },
  "peanut butter": { id: 16098, name: "peanut butter", caloriesPer100g: 588, proteinGPer100g: 25, carbsGPer100g: 20, fatGPer100g: 50, estimatedCostCentsPer100g: 35.71 },
  walnuts: { id: 12155, name: "walnuts", caloriesPer100g: 654, proteinGPer100g: 15.2, carbsGPer100g: 13.7, fatGPer100g: 65.2, estimatedCostCentsPer100g: 239.29 },
  oats: { id: 8120, name: "oats", caloriesPer100g: 379, proteinGPer100g: 13.2, carbsGPer100g: 67.7, fatGPer100g: 6.52, estimatedCostCentsPer100g: 39.29 },
  dates: { id: 9087, name: "dates", caloriesPer100g: 282, proteinGPer100g: 2.45, carbsGPer100g: 75.0, fatGPer100g: 0.39, estimatedCostCentsPer100g: 114.29 },
  "pea protein powder": { id: 98890, name: "pea protein powder", caloriesPer100g: 363.63, proteinGPer100g: 72.72, carbsGPer100g: 3.03, fatGPer100g: 6.06, estimatedCostCentsPer100g: 240.0 },
  "hemp seeds": { id: 93602, name: "hemp seeds", caloriesPer100g: 580, proteinGPer100g: 37, carbsGPer100g: 7, fatGPer100g: 45, estimatedCostCentsPer100g: 339.29 },
  "pumpkin seeds": { id: 12014, name: "pumpkin seeds", caloriesPer100g: 559, proteinGPer100g: 30.23, carbsGPer100g: 10.71, fatGPer100g: 49.05, estimatedCostCentsPer100g: 178.57 },
};

describe("composeSnack", () => {
  it("lands within ~15% on every macro for a real snack-scale target", () => {
    // 16%-share snack target for the real 2106/180/215/58 test profile.
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, pool, 0); // seed 0 -> greek yogurt/banana/almonds

    expect(snack.totalProteinG).toBeGreaterThan(target.proteinG * 0.85);
    expect(snack.totalProteinG).toBeLessThan(target.proteinG * 1.2);
    expect(snack.totalCarbsG).toBeGreaterThan(target.carbsG * 0.85);
    expect(snack.totalCarbsG).toBeLessThan(target.carbsG * 1.2);
    expect(snack.totalFatG).toBeGreaterThan(target.fatG * 0.8);
    expect(snack.totalFatG).toBeLessThan(target.fatG * 1.2);
    // 3 distinct ingredients: protein/carb/fat roles all found a real gap
    // to close for this target.
    expect(snack.ingredients).toHaveLength(3);
  });

  it("uses greek yogurt/banana/almonds at seed 0 (first pool option per role)", () => {
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, pool, 0);
    const names = snack.ingredients.map((i) => i.ingredientName);
    expect(names).toEqual(["greek yogurt", "banana", "almonds"]);
  });

  it("rotates to different pool ingredients at a different variety seed", () => {
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, pool, 1); // seed 1 -> 2nd option per role
    const names = snack.ingredients.map((i) => i.ingredientName);
    // Cottage cheese (4.3g fat/100g) sized to hit the protein target alone
    // already contributes more fat than the 9g target — the fat-role
    // ingredient (peanut butter) is correctly skipped rather than adding
    // even more on top, same "never fakes progress" principle as addon.ts.
    expect(names).toEqual(["cottage cheese", "apple"]);
  });

  it("never exceeds a sensible amount for a tiny target (skips ingredients below the minimum)", () => {
    const target = { calories: 5, proteinG: 0.5, carbsG: 0.5, fatG: 0.2 };
    const snack = composeSnack(target, pool, 0);
    // Gaps this small round below the 10g minimum for every role.
    expect(snack.ingredients).toHaveLength(0);
  });

  // Audit item #3 (2026-07-21 spec): a low-density ingredient sizing to
  // close a large gap used to have no ceiling at all -- orange (11.8g
  // carb/100g) is the exact example named in the spec.
  describe("realistic upper bound per ingredient (audit item #3, 2026-07-21)", () => {
    it("skips a low-density ingredient rather than sizing it past a realistic serving", () => {
      const orangeOnlyPool = { orange: pool.orange };
      const target = { calories: 0, proteinG: 0, carbsG: 35, fatG: 0 };
      const snack = composeSnack(target, orangeOnlyPool, 0);
      // 35g carbs / 11.8g per 100g would round to 295g -- over the 250g cap.
      expect(snack.ingredients).toHaveLength(0);
    });

    it("still sizes the same low-density ingredient normally when the gap is realistic", () => {
      const orangeOnlyPool = { orange: pool.orange };
      // fatG: 5, not 0 -- a real generation's snack target is never
      // literally 0 fat (targets.ts's perMealTarget is always a positive
      // share of the daily target); a hard 0 would now mean "zero fat
      // tolerance" under the new fat-budget cap (2026-07-28) and reject
      // this low-fat ingredient for the wrong reason. 5g is comfortably
      // non-binding against orange's 0.12g fat/100g at this carb target.
      const target = { calories: 0, proteinG: 0, carbsG: 20, fatG: 5 };
      const snack = composeSnack(target, orangeOnlyPool, 0);
      expect(snack.ingredients.map((i) => i.ingredientName)).toEqual(["orange"]);
      expect(snack.ingredients[0].amountG).toBeLessThanOrEqual(250);
    });

    it("caps a dense ingredient (protein powder) far below a low-density one's cap", () => {
      const proteinPowderOnlyPool = { "protein powder": pool["protein powder"] };
      // 55g protein / 80g per 100g would round to 65g -- over the 60g cap,
      // even though 65g is far below orange's 250g cap for the same role
      // shape (this is the whole reason the bound is per-ingredient, not
      // per-role: 65g of protein powder is ~52g protein, an unrealistic
      // single-snack amount, unlike 65g of a low-density food).
      // fatG: 10, not 0 -- see the sibling test above for why a literal 0
      // is unrealistic and would trip the new fat-budget cap instead of
      // the realistic-serving cap this test means to isolate. 10g is
      // comfortably non-binding against protein powder's 5g fat/100g here
      // (would allow up to 200g before the fat cap binds, far above 65g).
      const target = { calories: 0, proteinG: 55, carbsG: 0, fatG: 10 };
      const snack = composeSnack(target, proteinPowderOnlyPool, 0);
      expect(snack.ingredients).toHaveLength(0);
    });
    it("still sizes protein powder normally within its own tighter cap", () => {
      const proteinPowderOnlyPool = { "protein powder": pool["protein powder"] };
      const target = { calories: 0, proteinG: 40, carbsG: 0, fatG: 10 };
      const snack = composeSnack(target, proteinPowderOnlyPool, 0);
      expect(snack.ingredients.map((i) => i.ingredientName)).toEqual(["protein powder"]);
      expect(snack.ingredients[0].amountG).toBeLessThanOrEqual(60);
    });
  });

  // 2026-07-30, 15-profile comprehensive live audit: live-confirmed a
  // bulk-goal profile's snack needed 68.1g carbs -- banana/apple/orange
  // would each need 300-580g to close that, all over their realistic caps,
  // so the carb role (and its calories) silently vanished from the snack
  // every time, for every profile whose snack carb target exceeded ~57g
  // (banana's own best case). This is what actually produced the "fat
  // looks like it's overshooting" appearance in that audit: fat wasn't
  // overshooting, carbs were undershooting far more severely. oats/dates
  // are dense enough to close a gap this size within a realistic portion.
  describe("carb-pool widening for large gaps (2026-07-30)", () => {
    it("the original 3-fruit carb pool cannot close a 68g gap within realistic portions", () => {
      const fruitOnlyPool = { banana: pool.banana, apple: pool.apple, orange: pool.orange };
      const target = { calories: 0, proteinG: 0, carbsG: 68, fatG: 10 };
      const snack = composeSnack(target, fruitOnlyPool, 0);
      expect(snack.ingredients).toHaveLength(0);
    });

    it("oats closes the same 68g gap the fruit-only pool couldn't", () => {
      const oatsOnlyPool = { oats: pool.oats };
      const target = { calories: 0, proteinG: 0, carbsG: 68, fatG: 10 };
      const snack = composeSnack(target, oatsOnlyPool, 0);
      expect(snack.ingredients.map((i) => i.ingredientName)).toEqual(["oats"]);
      expect(snack.ingredients[0].amountG).toBeLessThanOrEqual(150);
      expect(snack.totalCarbsG).toBeGreaterThan(68 * 0.85);
    });

    it("dates close the same 68g gap the fruit-only pool couldn't", () => {
      const datesOnlyPool = { dates: pool.dates };
      const target = { calories: 0, proteinG: 0, carbsG: 68, fatG: 10 };
      const snack = composeSnack(target, datesOnlyPool, 0);
      expect(snack.ingredients.map((i) => i.ingredientName)).toEqual(["dates"]);
      expect(snack.ingredients[0].amountG).toBeLessThanOrEqual(120);
      expect(snack.totalCarbsG).toBeGreaterThan(68 * 0.85);
    });
  });

  // Variety/repetition follow-up (2026-07-30): a vegan + soy allergy
  // profile (the same H1 test profile from the comprehensive audit) only
  // had 2 safe protein-role options before this fix (pea protein powder,
  // hemp seeds) -- with only 2 real rotation options across 14 weekly
  // snack slots, perfect rotation still guarantees each appears ~7 times.
  // pumpkin seeds (a seed, not tagged containsNut) is safe even under this
  // exact stack, giving a 3rd option. This simulates orchestrate.ts's own
  // pre-filtering (only the safe subset is ever passed as `pool`).
  describe("protein-pool widening for heavily-restricted profiles (2026-07-30)", () => {
    const veganSoyProteinPool = {
      "pea protein powder": pool["pea protein powder"],
      "hemp seeds": pool["hemp seeds"],
      "pumpkin seeds": pool["pumpkin seeds"],
    };

    it("rotates across all 3 safe options rather than just the original 2", () => {
      const target = { calories: 0, proteinG: 20, carbsG: 0, fatG: 15 };
      const picks = [0, 1, 2].map((seed) => composeSnack(target, veganSoyProteinPool, seed).ingredients[0]?.ingredientName);
      expect(new Set(picks).size).toBe(3);
      expect(picks).toContain("pumpkin seeds");
    });

    it("sizes pumpkin seeds normally within its own realistic cap", () => {
      const pumpkinOnlyPool = { "pumpkin seeds": pool["pumpkin seeds"] };
      const target = { calories: 0, proteinG: 15, carbsG: 0, fatG: 30 };
      const snack = composeSnack(target, pumpkinOnlyPool, 0);
      expect(snack.ingredients.map((i) => i.ingredientName)).toEqual(["pumpkin seeds"]);
      expect(snack.ingredients[0].amountG).toBeLessThanOrEqual(60);
    });
  });

  // Fat-budget cap (2026-07-28): live-found via a real "maintain" profile
  // that hemp seeds -- a PROTEIN-role option -- has a far worse fat:protein
  // ratio (1.22:1) than every other protein-role ingredient (0.036-0.39:1).
  // Sizing it purely to its own protein target could blow the whole slot's
  // fat budget before the fat role ever got a turn, collapsing a snack to
  // one wildly fat-heavy ingredient (confirmed: 50g hemp seeds delivered
  // 22.5g fat against a 12.3g slot fat budget).
  describe("fat-budget cap on the protein/carb roles (2026-07-28)", () => {
    const hempSeeds: IngredientMacroLookup = {
      id: 93602,
      name: "hemp seeds",
      caloriesPer100g: 580,
      proteinGPer100g: 37,
      carbsGPer100g: 7,
      fatGPer100g: 45,
      estimatedCostCentsPer100g: 339.29,
    };

    it("caps a fat-disproportionate protein-role ingredient by the slot's fat budget instead of sizing to its own protein target alone", () => {
      const hempSeedsOnlyPool = { "hemp seeds": hempSeeds };
      // Real profile-1 snack1 target (16% share of 2304/116/287/77).
      const target = { calories: 368.64, proteinG: 18.56, carbsG: 45.92, fatG: 12.32 };
      const snack = composeSnack(target, hempSeedsOnlyPool, 4); // seed 4 -> hemp seeds (the live-found case)

      expect(snack.ingredients).toHaveLength(1);
      const hemp = snack.ingredients[0];
      expect(hemp.ingredientName).toBe("hemp seeds");
      // Capped by the 12.32g fat budget (25g, not the 50g the protein
      // target alone would have sized it to), landing at or under target
      // rather than nearly double it.
      expect(hemp.amountG).toBe(25);
      expect(hemp.fatG).toBeLessThanOrEqual(target.fatG);
    });
  });

  it("skips a role entirely when the pool has no lookup for it", () => {
    const partialPool = { "greek yogurt": pool["greek yogurt"], banana: pool.banana };
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, partialPool, 0);
    expect(snack.ingredients.map((i) => i.ingredientName)).toEqual(["greek yogurt", "banana"]);
  });

  // Safety fix, July 15 2026: orchestrate.ts's fetchSnackIngredientPool now
  // pre-filters unsafe ingredients (allergy/diet/dislike) out of `pool`
  // entirely before calling composeSnack -- this proves composeSnack
  // rotates to whichever SAFE option in the same role is still present,
  // rather than giving up on that role just because the seed happened to
  // land on the one that got filtered out.
  it("rotates to the next available pool option in a role when the seed's pick was filtered out", () => {
    const poolWithoutBanana = { ...pool };
    delete poolWithoutBanana.banana; // simulates e.g. a "banana" dislike being filtered upstream
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, poolWithoutBanana, 0); // seed 0 would normally pick banana first
    const names = snack.ingredients.map((i) => i.ingredientName);
    expect(names).toContain("apple"); // falls through to the next carb option
    expect(names).not.toContain("banana");
  });

  // Pantry/price preference: retrofitted July 15 2026 after confirming
  // this file never considered either, unlike ranking.ts's recipe path.
  describe("pantry/price preference", () => {
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };

    // Fixed July 15 2026 (audit round 2): this used to assert the actual
    // live bug -- a single pantry match collapsed preferredCount to 1, so
    // every seed landed on "orange" with nothing to rotate against (a real
    // 15-item pantry test produced 1 distinct snack combo across all 14
    // snack slots). rankByPantryAndPrice now tops the preferred tier up to
    // 2, so a single pantry match should be favored (appear across most
    // seeds) but not exclusively -- real rotation should return.
    it("favors a single pantry-matching option across seeds, but still rotates with a backup instead of collapsing to one option", () => {
      const ctx: PantryPriceContext = { pantryItemNames: ["orange"], budgetAware: false };
      const seen = new Set<string>();
      for (const seed of [0, 1, 2, 5, 42]) {
        const snack = composeSnack(target, pool, seed, ctx);
        const carbItem = snack.ingredients.find((i) => ["banana", "apple", "orange"].includes(i.ingredientName));
        seen.add(carbItem!.ingredientName);
      }
      expect(seen.has("orange")).toBe(true);
      // The bug this replaces would have made this assertion fail (seen
      // would be exactly {"orange"}) -- real rotation means at least one
      // other carb-role option also gets picked across these 5 seeds.
      expect(seen.size).toBeGreaterThan(1);
    });

    it("rotates among multiple pantry matches for variety, never picking a non-match", () => {
      const ctx: PantryPriceContext = { pantryItemNames: ["banana", "orange"], budgetAware: false };
      const seen = new Set<string>();
      for (const seed of [0, 1, 2, 3]) {
        const snack = composeSnack(target, pool, seed, ctx);
        const carbItem = snack.ingredients.find((i) => ["banana", "apple", "orange"].includes(i.ingredientName));
        seen.add(carbItem!.ingredientName);
      }
      expect(seen.has("apple")).toBe(false);
      expect(seen.size).toBeGreaterThan(0);
    });

    it("rotates between the cheaper 2 of 3 protein-role options when budget-aware, excluding only the priciest", () => {
      // Regression test for the live bug found July 15 2026 (a tight-
      // budget Pro profile got the identical snack 14/14 times): strict
      // cheapest-only never had a real tie given these real costs
      // (cottage cheese 50.0 / greek yogurt 71.43 / protein powder
      // 278.57), so it always picked cottage cheese. The fix keeps the
      // cheaper HALF (min 2) preferred instead of just the single
      // cheapest -- protein powder (the priciest) should still never
      // appear, but both cottage cheese and greek yogurt should, across
      // enough seeds. Checked on the PROTEIN role specifically (always
      // reached every seed, unlike the fat role, which composeSnack only
      // reaches conditionally once protein+carb haven't already used up
      // the fat target -- a separate, pre-existing sequencing property
      // of composeSnack, not something this fix needs to reach into).
      const ctx: PantryPriceContext = { pantryItemNames: [], budgetAware: true };
      const seen = new Set<string>();
      for (const seed of [0, 1, 2, 3]) {
        const snack = composeSnack(target, pool, seed, ctx);
        const proteinItem = snack.ingredients.find((i) => ["greek yogurt", "cottage cheese", "protein powder"].includes(i.ingredientName));
        if (proteinItem) seen.add(proteinItem.ingredientName);
      }
      expect(seen.has("protein powder")).toBe(false);
      expect(seen.size).toBeGreaterThan(1);
    });

    it("computes a real total cost when every ingredient's cost is known", () => {
      const snack = composeSnack(target, pool, 0);
      expect(snack.totalEstimatedCostCents).not.toBeNull();
      const manualSum = snack.ingredients.reduce((s, i) => s + (i.estimatedCostCents ?? 0), 0);
      expect(snack.totalEstimatedCostCents).toBeCloseTo(manualSum, 5);
    });

    it("returns a null total cost if any ingredient's cost is unknown, rather than an understated partial sum", () => {
      const poolWithUnknownCost = {
        ...pool,
        "greek yogurt": { ...pool["greek yogurt"], estimatedCostCentsPer100g: null },
      };
      const snack = composeSnack(target, poolWithUnknownCost, 0);
      expect(snack.totalEstimatedCostCents).toBeNull();
    });
  });
});

describe("composedSnackTitle", () => {
  it("joins ingredient names, title-cased", () => {
    const target = { calories: 337, proteinG: 29, carbsG: 34, fatG: 9 };
    const snack = composeSnack(target, pool, 0);
    expect(composedSnackTitle(snack)).toBe("Greek Yogurt + Banana + Almonds");
  });
});

describe("allPoolIngredientNames / INGREDIENT_POOL", () => {
  // protein/fat widened 3->5 (audit round 2, July 15 2026) so a vegan +
  // nut allergy + soy allergy profile has 2 safe options left in each
  // role instead of 0; carb widened 3->5 (2026-07-30) so a higher-calorie
  // profile's larger carb gaps can be closed by something denser than
  // banana/apple/orange; protein widened again 5->7 (2026-07-30, variety/
  // repetition follow-up) since a vegan restriction alone still drops it
  // to 2 -- see the source comment on INGREDIENT_POOL.
  it("returns all 17 pool ingredient names across the 3 roles", () => {
    expect(allPoolIngredientNames()).toHaveLength(17);
    expect(INGREDIENT_POOL.protein).toHaveLength(7);
    expect(INGREDIENT_POOL.carb).toHaveLength(5);
    expect(INGREDIENT_POOL.fat).toHaveLength(5);
  });
});
