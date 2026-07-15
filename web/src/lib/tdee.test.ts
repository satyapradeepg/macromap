import { describe, it, expect } from "vitest";
import { calculateBmr, calculateTdee, calculateMacroTargets, AGE_RANGE, MIN_DAILY_CALORIES } from "./tdee";

describe("calculateBmr", () => {
  it("applies the +5 male constant", () => {
    const bmr = calculateBmr({ weightKg: 80, heightCm: 180, age: 30, biologicalSex: "male" });
    expect(bmr).toBeCloseTo(10 * 80 + 6.25 * 180 - 5 * 30 + 5, 5);
  });

  it("applies the -161 female constant", () => {
    const bmr = calculateBmr({ weightKg: 65, heightCm: 165, age: 30, biologicalSex: "female" });
    expect(bmr).toBeCloseTo(10 * 65 + 6.25 * 165 - 5 * 30 - 161, 5);
  });
});

describe("calculateTdee", () => {
  it("multiplies BMR by the activity multiplier", () => {
    expect(calculateTdee(1500, "sedentary")).toBeCloseTo(1800, 5);
    expect(calculateTdee(1500, "very_active")).toBeCloseTo(2587.5, 5);
  });
});

describe("calculateMacroTargets — goal-based caloric adjustment", () => {
  const tdee = 2000;
  const weightKg = 80;

  it("cut applies a 20% deficit below TDEE", () => {
    const targets = calculateMacroTargets(tdee, weightKg, "cut");
    expect(targets.dailyCalories).toBe(Math.round(tdee * 0.8));
  });

  it("bulk applies a 10% surplus above TDEE", () => {
    const targets = calculateMacroTargets(tdee, weightKg, "bulk");
    expect(targets.dailyCalories).toBe(Math.round(tdee * 1.1));
  });

  it("maintain keeps calories equal to TDEE", () => {
    const targets = calculateMacroTargets(tdee, weightKg, "maintain");
    expect(targets.dailyCalories).toBe(Math.round(tdee));
  });

  it("protein target is driven by bodyweight, not the adjusted calories, so it doesn't shrink during a cut", () => {
    const cut = calculateMacroTargets(tdee, weightKg, "cut");
    const maintain = calculateMacroTargets(tdee, weightKg, "maintain");
    // Different g/kg per goal (2.2 cut vs 1.6 maintain) means these aren't
    // equal, but cut's higher g/kg protein target must still fit within
    // cut's lower calorie budget without going negative on carbs.
    expect(cut.dailyProteinG).toBe(Math.round(2.2 * weightKg));
    expect(maintain.dailyProteinG).toBe(Math.round(1.6 * weightKg));
    expect(cut.dailyCarbsG).toBeGreaterThanOrEqual(0);
  });

  it("carbs floor at 0 rather than going negative when protein+fat exceed the adjusted calorie budget", () => {
    // A very heavy person on a steep cut: protein alone (2.2g/kg) can
    // exceed 80% of TDEE at high bodyweight-to-TDEE ratios.
    const targets = calculateMacroTargets(1200, 250, "cut");
    expect(targets.dailyCarbsG).toBe(0);
  });

  it("fat is computed as a percent of the adjusted (post-deficit/surplus) calories, not raw TDEE", () => {
    const cut = calculateMacroTargets(tdee, weightKg, "cut");
    const expectedFatG = Math.round(((tdee * 0.8) * 0.25) / 9);
    expect(cut.dailyFatG).toBe(expectedFatG);
  });

  // Audit round 2 (July 15 2026), finding 3's remaining half: a computed
  // target below mealplan/targets.ts's structural per-meal-floor sum
  // (750 kcal as of today's floor split) forces the whole plan over
  // target by construction. Floors the computed value at the source
  // rather than teaching the meal engine to cope with an arbitrarily low
  // target -- same category of fix as raising AGE_RANGE.min.
  describe("MIN_DAILY_CALORIES floor", () => {
    it("floors a very low computed target (small/sedentary/cut) up to 1,200", () => {
      // 30kg/100cm/18yo/sedentary/cut female: BMR=300+625-90-161=674,
      // TDEE=674*1.2=808.8, cut target would be 647.04 without the floor.
      const bmr = calculateBmr({ weightKg: 30, heightCm: 100, age: 18, biologicalSex: "female" });
      const tdeeVal = calculateTdee(bmr, "sedentary");
      const targets = calculateMacroTargets(tdeeVal, 30, "cut");
      expect(targets.dailyCalories).toBe(MIN_DAILY_CALORIES);
    });

    it("does not floor a normal target that's already above 1,200", () => {
      const targets = calculateMacroTargets(2000, 80, "cut"); // 2000*0.8 = 1600
      expect(targets.dailyCalories).toBe(1600);
    });

    it("has a value of 1,200", () => {
      expect(MIN_DAILY_CALORIES).toBe(1200);
    });
  });
});

describe("AGE_RANGE", () => {
  // Raised 13 -> 18 (audit round 2, July 15 2026): Mifflin-St Jeor is
  // validated for adults, not adolescents, and this app's own extreme
  // inputs could compute a sub-900-calorie "maintenance" target for a
  // 13-year-old -- a safety concern independent of any engine-precision
  // issue. See migration 0012_raise_age_minimum.sql for the full context.
  it("has a minimum of 18, not 13", () => {
    expect(AGE_RANGE.min).toBe(18);
  });
});
