import { describe, it, expect } from "vitest";
import { validateEditProposal, buildEditPrompt } from "./mealEditProposer";

const BASE_INPUT = {
  currentDishName: "Seitan Stir-Fry with Rice",
  currentIngredients: [
    { name: "seitan cutlets", amount: 150, unit: "g" },
    { name: "brown rice", amount: 100, unit: "g" },
  ],
  userInstruction: "double the seitan",
  mealType: "dinner" as const,
  target: { calories: 600, proteinG: 45, carbsG: 60, fatG: 15 },
  dietaryStyles: [],
  allergies: [],
  dislikes: [],
};

describe("validateEditProposal", () => {
  it("accepts a well-formed edit proposal", () => {
    const raw = {
      dishName: "Seitan Stir-Fry with Rice",
      ingredients: [
        { name: "seitan cutlets", role: "protein", amountG: 300 },
        { name: "brown rice", role: "carb", amountG: 100 },
      ],
      changeSummary: "Doubled the seitan.",
      titleIngredientCheck: "ok",
      constraintCheck: "ok",
    };
    const result = validateEditProposal(raw);
    expect(result).toEqual({
      dishName: "Seitan Stir-Fry with Rice",
      ingredients: [
        { name: "seitan cutlets", role: "protein", amountG: 300 },
        { name: "brown rice", role: "carb", amountG: 100 },
      ],
      changeSummary: "Doubled the seitan.",
    });
  });

  it("rejects a missing amountG -- unlike mealProposer's optional fixedAmountG, an edit never leaves an amount unsolved", () => {
    const raw = { dishName: "X", ingredients: [{ name: "seitan", role: "protein" }], changeSummary: "n/a" };
    expect(validateEditProposal(raw)).toBeNull();
  });

  it("rejects a non-numeric amountG", () => {
    const raw = { dishName: "X", ingredients: [{ name: "seitan", role: "protein", amountG: "a lot" }], changeSummary: "n/a" };
    expect(validateEditProposal(raw)).toBeNull();
  });

  it("rejects a zero or negative amountG", () => {
    const raw = { dishName: "X", ingredients: [{ name: "seitan", role: "protein", amountG: 0 }], changeSummary: "n/a" };
    expect(validateEditProposal(raw)).toBeNull();
  });

  it("rejects an invalid role", () => {
    const raw = { dishName: "X", ingredients: [{ name: "seitan", role: "vegetable", amountG: 100 }], changeSummary: "n/a" };
    expect(validateEditProposal(raw)).toBeNull();
  });

  it("rejects empty ingredients", () => {
    expect(validateEditProposal({ dishName: "X", ingredients: [], changeSummary: "n/a" })).toBeNull();
  });

  it("rejects a missing or empty dishName", () => {
    expect(validateEditProposal({ ingredients: [{ name: "x", role: "protein", amountG: 100 }], changeSummary: "n/a" })).toBeNull();
    expect(validateEditProposal({ dishName: "  ", ingredients: [{ name: "x", role: "protein", amountG: 100 }], changeSummary: "n/a" })).toBeNull();
  });

  it("falls back to a generic changeSummary when it's missing or empty", () => {
    const raw = { dishName: "X", ingredients: [{ name: "seitan", role: "protein", amountG: 100 }], changeSummary: "" };
    const result = validateEditProposal(raw);
    expect(result!.changeSummary).toBe("Updated the meal.");
  });

  it("falls back to a generic changeSummary when it's too long", () => {
    const raw = { dishName: "X", ingredients: [{ name: "seitan", role: "protein", amountG: 100 }], changeSummary: "x".repeat(200) };
    const result = validateEditProposal(raw);
    expect(result!.changeSummary).toBe("Updated the meal.");
  });

  it("rejects a null or non-object input", () => {
    expect(validateEditProposal(null)).toBeNull();
    expect(validateEditProposal("swap the chicken")).toBeNull();
  });
});

describe("buildEditPrompt", () => {
  it("includes the current ingredients with their amounts and units", () => {
    const prompt = buildEditPrompt(BASE_INPUT);
    expect(prompt).toContain("seitan cutlets (150 g)");
    expect(prompt).toContain("brown rice (100 g)");
  });

  it("includes the verbatim user instruction", () => {
    const prompt = buildEditPrompt(BASE_INPUT);
    expect(prompt).toContain('"double the seitan"');
  });

  it("states the target as context, not something to solve exactly", () => {
    const prompt = buildEditPrompt(BASE_INPUT);
    expect(prompt).toContain("for context only, not something to solve exactly");
    expect(prompt).toContain("600");
  });

  it("includes the hard-constraint block with allergies/dietary style/dislikes", () => {
    const prompt = buildEditPrompt({ ...BASE_INPUT, dietaryStyles: ["vegan"], allergies: ["peanuts"], dislikes: ["cilantro"] });
    expect(prompt).toContain("vegan");
    expect(prompt).toContain("peanuts");
    expect(prompt).toContain("cilantro");
  });

  it("tells the model to return the complete list, not a diff", () => {
    const prompt = buildEditPrompt(BASE_INPUT);
    expect(prompt).toMatch(/COMPLETE new ingredient list, not a diff/);
  });

  it("tells the model exactly one ingredient may have each of protein/carb/fat", () => {
    const prompt = buildEditPrompt(BASE_INPUT);
    expect(prompt).toMatch(/EXACTLY ONE ingredient may have role "protein"/);
  });

  // Retry-with-feedback, live bug 2026-08-09: a real multi-ingredient
  // recipe's role assignment can come back inconsistent across separate
  // calls for the identical request -- reproduced live by sending the
  // same message twice and getting two different duplicate_role failures.
  describe("priorAttemptFeedback", () => {
    it("omits the retry note entirely when there's no prior feedback", () => {
      const prompt = buildEditPrompt(BASE_INPUT);
      expect(prompt).not.toContain("your previous proposal");
    });

    it("includes the retry note with the specific feedback when present", () => {
      const prompt = buildEditPrompt({
        ...BASE_INPUT,
        priorAttemptFeedback: 'you assigned more than one ingredient to the "protein" role -- exactly one ingredient may have this role; move every other one to "fixed".',
      });
      expect(prompt).toContain("IMPORTANT -- your previous proposal for this exact edit was rejected");
      expect(prompt).toContain('more than one ingredient to the "protein" role');
      expect(prompt).toMatch(/don't just repeat the same choice/);
    });
  });
});
