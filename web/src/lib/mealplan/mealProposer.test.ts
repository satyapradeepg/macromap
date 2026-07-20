import { describe, it, expect } from "vitest";
import { validateProposal, buildPrompt, safeProteinExamples, buildBatchPrompt, validateBatchProposals } from "./mealProposer";

describe("validateProposal", () => {
  it("accepts a well-formed proposal", () => {
    const raw = {
      dishName: "Seitan Scramble with Spinach and Whole Wheat Toast",
      ingredients: [
        { name: "seitan cutlets", role: "protein" },
        { name: "whole wheat bread", role: "carb" },
        { name: "olive oil", role: "fat" },
        { name: "spinach", role: "fixed", fixedAmountG: 40 },
      ],
    };
    const result = validateProposal(raw);
    expect(result).not.toBeNull();
    expect(result!.dishName).toBe(raw.dishName);
    expect(result!.ingredients).toHaveLength(4);
  });

  it("rejects a missing dishName", () => {
    expect(validateProposal({ ingredients: [{ name: "x", role: "protein" }] })).toBeNull();
  });

  it("rejects an empty dishName", () => {
    expect(validateProposal({ dishName: "   ", ingredients: [{ name: "x", role: "protein" }] })).toBeNull();
  });

  it("rejects a non-array ingredients field", () => {
    expect(validateProposal({ dishName: "X", ingredients: "not an array" })).toBeNull();
  });

  it("rejects an ingredient with an invalid role", () => {
    const raw = { dishName: "X", ingredients: [{ name: "seitan", role: "vegetable" }] };
    expect(validateProposal(raw)).toBeNull();
  });

  it("rejects a fixed-role ingredient missing fixedAmountG", () => {
    const raw = { dishName: "X", ingredients: [{ name: "spinach", role: "fixed" }] };
    expect(validateProposal(raw)).toBeNull();
  });

  it("rejects a null or non-object input", () => {
    expect(validateProposal(null)).toBeNull();
    expect(validateProposal("a string")).toBeNull();
    expect(validateProposal(42)).toBeNull();
  });

  it("rejects an ingredient missing a name", () => {
    const raw = { dishName: "X", ingredients: [{ role: "protein" }] };
    expect(validateProposal(raw)).toBeNull();
  });
});

describe("buildPrompt", () => {
  it("includes the macro target, constraints, and pantry items", () => {
    const prompt = buildPrompt({
      mealType: "breakfast",
      target: { calories: 355, proteinG: 31, carbsG: 36, fatG: 10 },
      dietaryStyles: ["vegetarian"],
      allergies: ["eggs", "nuts"],
      dislikes: ["cilantro"],
      pantryItemNames: ["spinach", "olive oil"],
    });
    expect(prompt).toContain("355");
    expect(prompt).toContain("31");
    expect(prompt).toContain("vegetarian");
    expect(prompt).toContain("eggs");
    expect(prompt).toContain("nuts");
    expect(prompt).toContain("cilantro");
    expect(prompt).toContain("spinach");
    expect(prompt).toContain("olive oil");
    // Density-reasoning instruction (the lesson from the tofu/seitan spike).
    expect(prompt.toLowerCase()).toContain("protein-dense");
  });

  // Comprehensive engine test, July 16 2026: live-confirmed that Claude
  // proposed tempeh (a soy product) as the protein source in 9 of 10 real
  // AI-composition attempts for a vegan+soy-allergic profile, because the
  // prompt's own protein-density example list suggested "tempeh"
  // unconditionally -- the same prompt that listed "soy" as an allergy
  // two lines above. Every proposal was correctly rejected downstream by
  // the real safety gate (no leak), but the whole AI-compose budget was
  // wasted on doomed suggestions. The example list must exclude anything
  // that conflicts with the actual allergies/dietary style for this call.
  describe("safeProteinExamples respects allergies/dietary style", () => {
    it("never suggests tempeh for a soy allergy", () => {
      const examples = safeProteinExamples({ dietaryStyles: ["vegan"], allergies: ["nuts", "shellfish", "soy", "dairy"] });
      expect(examples.map((e) => e.toLowerCase())).not.toContain("tempeh");
    });

    it("never suggests seitan for a gluten_free profile", () => {
      const examples = safeProteinExamples({ dietaryStyles: ["gluten_free"], allergies: [] });
      expect(examples.map((e) => e.toLowerCase())).not.toContain("seitan");
    });

    it("never suggests dense cheese or lean meat for a vegan profile", () => {
      const examples = safeProteinExamples({ dietaryStyles: ["vegan"], allergies: [] }).join(" ").toLowerCase();
      expect(examples).not.toContain("dense cheese");
      expect(examples).not.toContain("lean meat");
    });

    it("still suggests tempeh and seitan for an unrestricted profile", () => {
      const examples = safeProteinExamples({ dietaryStyles: [], allergies: [] }).map((e) => e.toLowerCase());
      expect(examples).toContain("tempeh");
      expect(examples).toContain("seitan");
    });

    it("falls back to lentils/chickpeas rather than an empty list for a heavily-restricted profile", () => {
      const examples = safeProteinExamples({ dietaryStyles: ["vegan", "gluten_free"], allergies: ["soy", "dairy", "nuts"] });
      expect(examples.length).toBeGreaterThan(0);
      expect(examples.map((e) => e.toLowerCase())).toContain("lentils");
    });

    // Second-order finding from the same live test: once tempeh/seitan/
    // cheese/meat are filtered for a vegan+soy-allergic profile, "lentils"
    // alone isn't protein-dense enough to hit a demanding target within a
    // realistic portion -- every proposal was rejected by the
    // portion-realism check instead. Pea protein powder is dense enough to
    // actually work for this exact combination.
    it("includes a genuinely protein-dense option (pea protein powder) for a heavily-restricted vegan+soy-allergic profile", () => {
      const examples = safeProteinExamples({ dietaryStyles: ["vegan"], allergies: ["nuts", "shellfish", "soy", "dairy"] });
      expect(examples.map((e) => e.toLowerCase())).toContain("pea protein powder");
    });
  });

  it("includes the filtered protein examples in the built prompt", () => {
    const prompt = buildPrompt({
      mealType: "breakfast",
      target: { calories: 500, proteinG: 40, carbsG: 45, fatG: 12 },
      dietaryStyles: ["vegan"],
      allergies: ["nuts", "shellfish", "soy", "dairy"],
      dislikes: [],
      pantryItemNames: [],
    });
    expect(prompt).toContain("Options that fit the constraints above for this meal:");
    const suggestionLine = prompt.split("\n").find((l) => l.includes("Options that fit the constraints above"))!;
    expect(suggestionLine.toLowerCase()).not.toContain("tempeh");
  });

  it("omits the pantry line entirely when there are no pantry items", () => {
    const prompt = buildPrompt({
      mealType: "lunch",
      target: { calories: 500, proteinG: 40, carbsG: 50, fatG: 15 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
    });
    expect(prompt).not.toContain("Pantry on hand");
  });
});

// Batch-aware AI-compose (added 2026-07-20) -- gives Claude visibility
// into ALL currently-blocked slots + their combined target in one call,
// instead of one call per slot blind to the others.
describe("buildBatchPrompt", () => {
  it("lists every slot individually, in order, plus the combined aggregate target", () => {
    const prompt = buildBatchPrompt({
      slots: [
        { mealType: "breakfast", target: { calories: 400, proteinG: 22, carbsG: 48, fatG: 13 } },
        { mealType: "breakfast", target: { calories: 400, proteinG: 22, carbsG: 48, fatG: 13 } },
        { mealType: "lunch", target: { calories: 600, proteinG: 35, carbsG: 60, fatG: 18 } },
      ],
      aggregateTarget: { calories: 1400, proteinG: 79, carbsG: 156, fatG: 44 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
    });
    expect(prompt).toContain("Slot 1 (breakfast)");
    expect(prompt).toContain("Slot 2 (breakfast)");
    expect(prompt).toContain("Slot 3 (lunch)");
    expect(prompt).toContain("1400");
    expect(prompt).toContain("79");
    expect(prompt).toContain("Propose 3 realistic meals");
    expect(prompt).toContain("exactly 3 meals");
  });

  it("explicitly grants freedom to redistribute macros across the batch rather than matching each slot exactly", () => {
    const prompt = buildBatchPrompt({
      slots: [{ mealType: "dinner", target: { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 } }],
      aggregateTarget: { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
    });
    expect(prompt.toLowerCase()).toContain("do not need every single dish to hit its own individual share exactly");
  });

  it("still filters protein examples by allergies/dietary style, same as the single-slot prompt", () => {
    const prompt = buildBatchPrompt({
      slots: [{ mealType: "breakfast", target: { calories: 400, proteinG: 30, carbsG: 40, fatG: 12 } }],
      aggregateTarget: { calories: 400, proteinG: 30, carbsG: 40, fatG: 12 },
      dietaryStyles: ["vegan"],
      allergies: ["nuts", "shellfish", "soy", "dairy"],
      dislikes: [],
      pantryItemNames: [],
    });
    const suggestionLine = prompt.split("\n").find((l) => l.includes("Options that fit the constraints above"))!;
    expect(suggestionLine.toLowerCase()).not.toContain("tempeh");
  });
});

describe("validateBatchProposals", () => {
  const wellFormed = { dishName: "X", ingredients: [{ name: "seitan", role: "protein" }] };

  it("accepts an array matching the expected count", () => {
    const result = validateBatchProposals([wellFormed, wellFormed], 2);
    expect(result).toHaveLength(2);
  });

  it("rejects a count mismatch (too few)", () => {
    expect(validateBatchProposals([wellFormed], 2)).toBeNull();
  });

  it("rejects a count mismatch (too many)", () => {
    expect(validateBatchProposals([wellFormed, wellFormed, wellFormed], 2)).toBeNull();
  });

  it("rejects the whole batch if even one entry is malformed", () => {
    const malformed = { dishName: "", ingredients: [] };
    expect(validateBatchProposals([wellFormed, malformed], 2)).toBeNull();
  });

  it("rejects a non-array input", () => {
    expect(validateBatchProposals("not an array", 1)).toBeNull();
    expect(validateBatchProposals(null, 1)).toBeNull();
  });

  it("rejects an empty array when a positive count was expected", () => {
    expect(validateBatchProposals([], 2)).toBeNull();
  });
});
