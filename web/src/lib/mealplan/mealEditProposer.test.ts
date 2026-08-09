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
        { name: "seitan cutlets", role: "protein", amountG: 300, isPreExisting: true },
        { name: "brown rice", role: "carb", amountG: 100, isPreExisting: false },
      ],
      changeSummary: "Doubled the seitan.",
      titleIngredientCheck: "ok",
      constraintCheck: "ok",
    };
    const result = validateEditProposal(raw);
    expect(result).toEqual({
      dishName: "Seitan Stir-Fry with Rice",
      ingredients: [
        { name: "seitan cutlets", role: "protein", amountG: 300, isPreExisting: true },
        { name: "brown rice", role: "carb", amountG: 100, isPreExisting: false },
      ],
      changeSummary: "Doubled the seitan.",
    });
  });

  // Live design change 2026-08-09: replaces guessing "is this the same
  // ingredient as before" from word-subset name matching (which kept
  // needing a new curated fix every time a real recipe's raw name didn't
  // overlap enough words with the model's rephrasing -- "pkt firm/extra
  // tofu" vs "firm tofu", "group pepper" vs "black pepper") with an
  // explicit signal the model states directly, since it already knows the
  // answer while writing the proposal. Defensive, not strict, unlike
  // amountG -- a missing/non-boolean value degrades to false (no explicit
  // signal, falls back to the string-match backstop in
  // composeMealFromEditDetailed) rather than invalidating the whole
  // proposal, since this is a low-stakes bookkeeping field, not a
  // safety-critical one.
  it("parses isPreExisting defensively: true/false pass through, missing or non-boolean defaults to false", () => {
    const withTrue = validateEditProposal({
      dishName: "X",
      ingredients: [{ name: "seitan", role: "protein", amountG: 100, isPreExisting: true }],
      changeSummary: "n/a",
    });
    expect(withTrue!.ingredients[0].isPreExisting).toBe(true);

    const withFalse = validateEditProposal({
      dishName: "X",
      ingredients: [{ name: "seitan", role: "protein", amountG: 100, isPreExisting: false }],
      changeSummary: "n/a",
    });
    expect(withFalse!.ingredients[0].isPreExisting).toBe(false);

    const missing = validateEditProposal({
      dishName: "X",
      ingredients: [{ name: "seitan", role: "protein", amountG: 100 }],
      changeSummary: "n/a",
    });
    expect(missing!.ingredients[0].isPreExisting).toBe(false);

    const malformed = validateEditProposal({
      dishName: "X",
      ingredients: [{ name: "seitan", role: "protein", amountG: 100, isPreExisting: "yes" }],
      changeSummary: "n/a",
    });
    expect(malformed!.ingredients[0].isPreExisting).toBe(false);
  });

  // Second whack-a-mole fix, same session as isPreExisting above: the
  // model's own suggested generic/brand-free search term, used only as a
  // last-resort fallback in lookupIngredientMacros when the exact name and
  // every deterministic string transform have already failed (e.g. "karo
  // corn syrup" -> "corn syrup"). Defensive parsing, same reasoning as
  // isPreExisting -- a missing/empty/identical-to-name value just means no
  // fallback is available, not an invalid proposal.
  it("parses searchTerm defensively: a genuine hint passes through, missing/empty/identical-to-name becomes undefined", () => {
    const withHint = validateEditProposal({
      dishName: "X",
      ingredients: [{ name: "karo corn syrup", role: "fixed", amountG: 5, isPreExisting: true, searchTerm: "corn syrup" }],
      changeSummary: "n/a",
    });
    expect(withHint!.ingredients[0].searchTerm).toBe("corn syrup");

    const identical = validateEditProposal({
      dishName: "X",
      ingredients: [{ name: "chicken breast", role: "protein", amountG: 150, isPreExisting: true, searchTerm: "chicken breast" }],
      changeSummary: "n/a",
    });
    expect(identical!.ingredients[0].searchTerm).toBeUndefined();

    const missing = validateEditProposal({
      dishName: "X",
      ingredients: [{ name: "seitan", role: "protein", amountG: 100, isPreExisting: true }],
      changeSummary: "n/a",
    });
    expect(missing!.ingredients[0].searchTerm).toBeUndefined();

    const malformedSearchTerm = validateEditProposal({
      dishName: "X",
      ingredients: [{ name: "seitan", role: "protein", amountG: 100, isPreExisting: true, searchTerm: 42 }],
      changeSummary: "n/a",
    });
    expect(malformedSearchTerm!.ingredients[0].searchTerm).toBeUndefined();
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

  // Design change 2026-08-09: replaces guessing pre-existing-ness from
  // name string matching with an explicit model-stated signal.
  it("tells the model to explicitly mark each ingredient's isPreExisting status", () => {
    const prompt = buildEditPrompt(BASE_INPUT);
    expect(prompt).toMatch(/set "isPreExisting": true if it's the same ingredient/);
    expect(prompt).toMatch(/false if it's a genuinely new addition/);
  });

  it("tells the model to suggest a plain/generic/brand-free searchTerm for each ingredient", () => {
    const prompt = buildEditPrompt(BASE_INPUT);
    expect(prompt).toMatch(/set "searchTerm" for EACH ingredient/);
    expect(prompt).toMatch(/karo corn syrup.*corn syrup/);
  });

  // Live-confirmed 2026-08-09 (silent-substitution-masking bugs): asking
  // to add crushed almonds/cilantro/dry sherry to a nut-allergic/halal
  // meal correctly never added the conflicting ingredient (constraintCheck
  // already worked), but the OLD changeSummary instruction only asked
  // "what did you change," so the user-facing reply never explained that
  // anything had been declined -- surfacing as a confusing "already has
  // this" or a bare "Updated the meal." with no reason given. This
  // instruction is the fix at the source: it requires the model to name
  // what it declined and why, not just what it changed.
  it("requires changeSummary to disclose a declined or substituted ingredient, not just describe a generic change", () => {
    const prompt = buildEditPrompt(BASE_INPUT);
    expect(prompt).toMatch(/you declined it or substituted something else.*say so explicitly/i);
    expect(prompt).toContain("Don't let changeSummary describe a request as fulfilled when it wasn't.");
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
