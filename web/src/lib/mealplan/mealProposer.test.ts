import { describe, it, expect } from "vitest";
import { validateProposal, buildPrompt } from "./mealProposer";

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
