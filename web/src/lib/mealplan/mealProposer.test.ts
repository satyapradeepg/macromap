import { describe, it, expect } from "vitest";
import { validateProposal, buildPrompt, safeProteinExamples, buildBatchPrompt, validateBatchProposals, rescaleToAggregate } from "./mealProposer";

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

  // Found 2026-07-21 while wiring up the carb-budget prompt hint: this used
  // to reject the whole proposal, upstream of composeMealFromProposal's own
  // DEFAULT_FIXED_AMOUNT_G fallback -- meaning that fallback (added earlier
  // the same day, in response to a live-confirmed false rejection) could
  // never actually run in real production traffic, since a real Claude
  // proposal routinely omits fixedAmountG for a garnish and never made it
  // past this validator to reach that fallback. fixedAmountG is genuinely
  // optional on ProposedIngredient; only an invalid non-number value (e.g.
  // a string) should still reject, covered by the next test.
  it("accepts a fixed-role ingredient missing fixedAmountG (left undefined for composeMealFromProposal's own default)", () => {
    const raw = { dishName: "X", ingredients: [{ name: "spinach", role: "fixed" }] };
    const result = validateProposal(raw);
    expect(result).not.toBeNull();
    expect(result!.ingredients[0].fixedAmountG).toBeUndefined();
  });

  it("still rejects a fixed-role ingredient with a non-number fixedAmountG", () => {
    const raw = { dishName: "X", ingredients: [{ name: "spinach", role: "fixed", fixedAmountG: "forty" }] };
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

  // Retry-with-feedback (2026-07-30): when a slot's first AI-compose
  // attempt was rejected, the retry prompt must carry WHY, so the model
  // doesn't just re-roll the same doomed proposal.
  it("omits any retry-feedback paragraph when priorAttemptFeedback isn't set (first attempt)", () => {
    const prompt = buildPrompt({
      mealType: "breakfast",
      target: { calories: 355, proteinG: 31, carbsG: 36, fatG: 10 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
    });
    expect(prompt).not.toContain("your previous proposal");
  });

  it("includes the specific rejection feedback when priorAttemptFeedback is set (a retry)", () => {
    const prompt = buildPrompt({
      mealType: "breakfast",
      target: { calories: 355, proteinG: 31, carbsG: 36, fatG: 10 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
      priorAttemptFeedback: "Your protein choice, \"firm tofu\", needed 346g -- over the realistic 280g cap. Pick a denser protein source.",
    });
    expect(prompt).toContain("your previous proposal for this exact slot was rejected");
    expect(prompt).toContain("firm tofu");
    expect(prompt).toContain("over the realistic 280g cap");
  });

  // Variety/repetition follow-up (2026-07-30): the plan critic independently
  // flagged real dish-level repetition on an unrestricted profile ("Seitan
  // Stir-Fry with Rice and Broccoli", 4 of 7 days) -- separate AI-compose
  // calls have no memory of each other, so this feeds back what's already
  // been used elsewhere in the week.
  it("omits any avoid-repeats paragraph when avoidDishNames isn't set or empty", () => {
    const withoutField = buildPrompt({
      mealType: "breakfast",
      target: { calories: 355, proteinG: 31, carbsG: 36, fatG: 10 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
    });
    expect(withoutField).not.toContain("already used elsewhere");

    const withEmptyArray = buildPrompt({
      mealType: "breakfast",
      target: { calories: 355, proteinG: 31, carbsG: 36, fatG: 10 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
      avoidDishNames: [],
    });
    expect(withEmptyArray).not.toContain("already used elsewhere");
  });

  it("includes already-used dish titles when avoidDishNames is set", () => {
    const prompt = buildPrompt({
      mealType: "lunch",
      target: { calories: 500, proteinG: 40, carbsG: 45, fatG: 12 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
      avoidDishNames: ["Seitan Stir-Fry with Rice and Broccoli", "Chicken Enchiladas"],
    });
    expect(prompt).toContain("already used elsewhere in this week's plan");
    expect(prompt).toContain("Seitan Stir-Fry with Rice and Broccoli");
    expect(prompt).toContain("Chicken Enchiladas");
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

    // Stacked-safety investigation, 2026-07-22: the fix above (adding pea
    // protein powder) never actually removed lentils from the list, so
    // Claude kept picking lentils over the denser option anyway for a
    // demanding target -- live-confirmed 3/3 lunch attempts (32-38g
    // protein). Lentils' real measured density (9.02g/100g, confirmed
    // live) caps out at ~25g protein within the realistic 280g portion
    // bound, so it's now excluded once the target is demanding enough to
    // structurally rule it out.
    it("excludes lentils once the target protein is demanding enough that lentils structurally cannot reach it", () => {
      const examples = safeProteinExamples({ dietaryStyles: [], allergies: [] }, 38).map((e) => e.toLowerCase());
      expect(examples).not.toContain("lentils");
    });

    it("still includes lentils for a light target where it's a perfectly fine option", () => {
      const examples = safeProteinExamples({ dietaryStyles: [], allergies: [] }, 15).map((e) => e.toLowerCase());
      expect(examples).toContain("lentils");
    });

    it("still includes lentils when no target is given, unchanged from before this fix", () => {
      const examples = safeProteinExamples({ dietaryStyles: [], allergies: [] }).map((e) => e.toLowerCase());
      expect(examples).toContain("lentils");
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

  it("excludes lentils from the suggested options for a demanding protein target, and states the density ceiling", () => {
    const prompt = buildPrompt({
      mealType: "lunch",
      target: { calories: 800, proteinG: 38, carbsG: 100, fatG: 28 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
    });
    // Extract just the actual suggested-options list, not the whole
    // requirement-3 paragraph -- that paragraph now ALSO mentions "lentils"
    // by name descriptively, as part of explaining why it's excluded.
    const optionsList = prompt.match(/Options that fit the constraints above for this meal: (.+?)\. These are only starting points/)![1];
    expect(optionsList.toLowerCase()).not.toContain("lentils");
    expect(prompt.toLowerCase()).toContain("8-10g protein per 100g");
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

  // Live-validated 2026-07-21 (thin-corpus AI-compose investigation):
  // Claude's default plant-protein choices (lentils, quinoa) are carb-heavy
  // enough that sizing them to hit a moderate protein target blows a tight
  // carb budget before the carb-role ingredient is even added -- confirmed
  // via a live instrumented trace (remainingCarbs went to -32.85 after
  // sizing lentils alone). A carb-budget-aware hint fixed this on 3/3
  // tested corpus-scarce targets once added. Unconditional (not gated on
  // the target's carb/protein ratio) -- an earlier attempt at a cheap ratio
  // gate (carbsG < proteinG) failed to fire on a real case that still
  // needed the hint (carbsG=26.64 > proteinG=22.4, since lentils' own
  // ~2.2:1 carb-to-protein ratio blew that budget too), and this fallback
  // is already narrow/rare (only blocked or bad-fit slots), so the
  // always-on cost is bounded.
  it("warns that a starchy legume/grain sized for protein can blow the carb budget, and points back to the already-filtered example list", () => {
    const prompt = buildPrompt({
      mealType: "lunch",
      target: { calories: 300, proteinG: 24, carbsG: 21, fatG: 9 },
      dietaryStyles: ["vegan"],
      allergies: ["nuts", "soy"],
      dislikes: [],
      pantryItemNames: [],
    });
    const lower = prompt.toLowerCase();
    expect(lower).toContain("carb budget");
    expect(lower).toContain("lentils");
    // Must reuse the already-filtered requirement-3 list, not introduce a
    // NEW unfiltered example -- an earlier draft of this hint hardcoded
    // "tofu" as an example, reintroducing the exact tempeh/soy-allergy
    // contradiction this file's own July 16 2026 fix already solved once.
    expect(lower).not.toContain("tofu,");
    expect(lower).toContain("requirement 3");
  });

  // Best-effort mitigation for a genuine prompt-adherence gap (2026-07-22,
  // stacked-safety investigation): Claude occasionally proposes an
  // ingredient that directly contradicts a constraint stated in the same
  // prompt (seitan for gluten_free, almonds for a nuts allergy) --
  // always caught by the real safety gate downstream, but the whole
  // AI-compose attempt is wasted. This is a cheap, single-call nudge
  // (a required tool-schema field asking Claude to re-check its own
  // picks), not a guaranteed fix -- verified live separately, not by
  // this test, which only confirms the prompt actually asks for it.
  it("instructs Claude to fill in a final constraint self-check after picking ingredients", () => {
    const prompt = buildPrompt({
      mealType: "lunch",
      target: { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 },
      dietaryStyles: ["vegetarian", "gluten_free"],
      allergies: ["nuts"],
      dislikes: [],
      pantryItemNames: [],
    });
    const lower = prompt.toLowerCase();
    expect(lower).toContain("constraintcheck");
    expect(lower).toContain("last");
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

  // Variety/repetition follow-up (2026-07-30) -- same rationale as
  // buildPrompt's equivalent test above, for the batch path.
  it("includes already-used dish titles when avoidDishNames is set, omits the paragraph when not", () => {
    const withoutField = buildBatchPrompt({
      slots: [{ mealType: "dinner", target: { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 } }],
      aggregateTarget: { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
    });
    expect(withoutField).not.toContain("already used elsewhere");

    const withField = buildBatchPrompt({
      slots: [{ mealType: "dinner", target: { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 } }],
      aggregateTarget: { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
      avoidDishNames: ["Seitan Stir-Fry with Rice and Broccoli"],
    });
    expect(withField).toContain("already used elsewhere in this week's plan");
    expect(withField).toContain("Seitan Stir-Fry with Rice and Broccoli");
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

  // Found live July 20 2026 (extreme-max-boundary profile): a 7-slot batch
  // call only used its redistribution freedom for 1/7 dishes -- the vague
  // "feel free to lean higher/lower" wording didn't actually steer Claude
  // toward concentrating protein into fewer dense dishes. Strengthened to
  // explicitly recommend concentration over even spreading.
  it("explicitly recommends concentrating protein into fewer dense dishes rather than spreading evenly", () => {
    const prompt = buildBatchPrompt({
      slots: [{ mealType: "breakfast", target: { calories: 1200, proteinG: 84, carbsG: 141, fatG: 33 } }],
      aggregateTarget: { calories: 1200, proteinG: 84, carbsG: 141, fatG: 33 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
    });
    expect(prompt.toLowerCase()).toContain("concentrate");
    expect(prompt.toLowerCase()).toContain("densest protein source");
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

  // Found while designing the constraintCheck self-check field (2026-07-22,
  // stacked-safety investigation): the concentration-guidance paragraph
  // hardcoded "protein powder, seitan, lean poultry" as example dense
  // proteins, completely unfiltered against the actual constraints -- and
  // it appears BEFORE the "Hard constraints" section even states them.
  // Same bug class as the July 16 tempeh-for-soy-allergy fix, just worse:
  // the unsafe example came before the constraint, not two lines after it.
  // Likely a real contributing cause of the repeated seitan-under-
  // gluten_free live failures, not just Claude ignoring instructions.
  it("does not hardcode an unfiltered protein example in the concentration-guidance paragraph", () => {
    const prompt = buildBatchPrompt({
      slots: [{ mealType: "breakfast", target: { calories: 1200, proteinG: 84, carbsG: 141, fatG: 33 } }],
      aggregateTarget: { calories: 1200, proteinG: 84, carbsG: 141, fatG: 33 },
      dietaryStyles: ["gluten_free"],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
    });
    const concentrationParagraph = prompt.match(/most reliable strategy is to CONCENTRATE.*?for 1-2 of these dishes/)![0];
    expect(concentrationParagraph.toLowerCase()).not.toContain("seitan");
  });

  // Stacked-safety investigation, 2026-07-22: gates against the MOST
  // demanding slot in the batch, not any single slot's own even share --
  // the prompt explicitly tells Claude it can concentrate a slot's
  // protein well above that share, so any slot could plausibly end up
  // needing close to the batch's most demanding target.
  it("excludes lentils from the suggested options when ANY slot in the batch has a demanding protein target", () => {
    const prompt = buildBatchPrompt({
      slots: [
        { mealType: "breakfast", target: { calories: 400, proteinG: 15, carbsG: 48, fatG: 13 } },
        { mealType: "lunch", target: { calories: 800, proteinG: 38, carbsG: 100, fatG: 28 } },
      ],
      aggregateTarget: { calories: 1200, proteinG: 53, carbsG: 148, fatG: 41 },
      dietaryStyles: [],
      allergies: [],
      dislikes: [],
      pantryItemNames: [],
    });
    // Same reasoning as buildPrompt's equivalent test -- extract just the
    // suggested-options list, not the whole requirement-4 paragraph (which
    // now also mentions "lentils" descriptively).
    const optionsList = prompt.match(/Options that fit the constraints above: (.+?)\. These are only starting points/)![1];
    expect(optionsList.toLowerCase()).not.toContain("lentils");
  });

  // Same carb-budget mechanism as buildPrompt's own test above, per-dish
  // rather than per-slot since each dish sets its own targetCarbsG/
  // targetProteinG allocation in the batch schema.
  it("warns that a starchy legume/grain sized for a dish's protein allocation can blow ITS carb allocation", () => {
    const prompt = buildBatchPrompt({
      slots: [{ mealType: "lunch", target: { calories: 300, proteinG: 24, carbsG: 21, fatG: 9 } }],
      aggregateTarget: { calories: 300, proteinG: 24, carbsG: 21, fatG: 9 },
      dietaryStyles: ["vegan"],
      allergies: ["nuts", "soy"],
      dislikes: [],
      pantryItemNames: [],
    });
    const lower = prompt.toLowerCase();
    expect(lower).toContain("carb budget");
    expect(lower).toContain("lentils");
    expect(lower).not.toContain("tofu,");
    expect(lower).toContain("requirement 4");
  });

  // Same self-check mitigation as buildPrompt's own test above, per-dish
  // since each meal in the batch schema needs its own constraintCheck.
  it("instructs Claude to fill in a final constraint self-check for each dish, after picking its ingredients", () => {
    const prompt = buildBatchPrompt({
      slots: [{ mealType: "lunch", target: { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 } }],
      aggregateTarget: { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 },
      dietaryStyles: ["vegetarian", "gluten_free"],
      allergies: ["nuts"],
      dislikes: [],
      pantryItemNames: [],
    });
    const lower = prompt.toLowerCase();
    expect(lower).toContain("constraintcheck");
    expect(lower).toContain("last");
  });
});

describe("validateBatchProposals", () => {
  const wellFormed = {
    dishName: "X",
    targetCalories: 500,
    targetProteinG: 30,
    targetCarbsG: 50,
    targetFatG: 15,
    ingredients: [{ name: "seitan", role: "protein" }],
  };
  const aggregateTarget = { calories: 1000, proteinG: 60, carbsG: 100, fatG: 30 };

  it("accepts an array matching the expected count, pairing each proposal with its own rescaled target", () => {
    const result = validateBatchProposals([wellFormed, wellFormed], 2, aggregateTarget);
    expect(result).toHaveLength(2);
    expect(result![0].proposal.dishName).toBe("X");
    // Both dishes stated identical targets (500/30/50/15 each, summing to
    // 1000/60/100/30) which already exactly matches the aggregate, so
    // rescaling should be a no-op here.
    expect(result![0].target).toEqual({ calories: 500, proteinG: 30, carbsG: 50, fatG: 15 });
  });

  it("rejects a count mismatch (too few)", () => {
    expect(validateBatchProposals([wellFormed], 2, aggregateTarget)).toBeNull();
  });

  it("rejects a count mismatch (too many)", () => {
    expect(validateBatchProposals([wellFormed, wellFormed, wellFormed], 2, aggregateTarget)).toBeNull();
  });

  it("rejects the whole batch if even one entry is malformed", () => {
    const malformed = { dishName: "", ingredients: [] };
    expect(validateBatchProposals([wellFormed, malformed], 2, aggregateTarget)).toBeNull();
  });

  it("rejects a non-array input", () => {
    expect(validateBatchProposals("not an array", 1, aggregateTarget)).toBeNull();
    expect(validateBatchProposals(null, 1, aggregateTarget)).toBeNull();
  });

  it("rejects an empty array when a positive count was expected", () => {
    expect(validateBatchProposals([], 2, aggregateTarget)).toBeNull();
  });

  it("rejects an entry missing a target field", () => {
    const { targetProteinG, ...missingProtein } = wellFormed;
    void targetProteinG;
    expect(validateBatchProposals([missingProtein], 1, { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 })).toBeNull();
  });

  it("rejects an entry with a non-positive or non-numeric target field", () => {
    expect(validateBatchProposals([{ ...wellFormed, targetProteinG: 0 }], 1, aggregateTarget)).toBeNull();
    expect(validateBatchProposals([{ ...wellFormed, targetProteinG: -5 }], 1, aggregateTarget)).toBeNull();
    expect(validateBatchProposals([{ ...wellFormed, targetCalories: "500" }], 1, aggregateTarget)).toBeNull();
  });

  it("rescales stated targets so they sum exactly to the real aggregate", () => {
    // Two dishes each state 500/30/50/15 (sums to 1000/60/100/30), but the
    // real aggregate is double that -- every dish's target should double too.
    const doubledAggregate = { calories: 2000, proteinG: 120, carbsG: 200, fatG: 60 };
    const result = validateBatchProposals([wellFormed, wellFormed], 2, doubledAggregate);
    expect(result![0].target).toEqual({ calories: 1000, proteinG: 60, carbsG: 100, fatG: 30 });
    expect(result![1].target).toEqual({ calories: 1000, proteinG: 60, carbsG: 100, fatG: 30 });
  });
});

describe("rescaleToAggregate", () => {
  it("preserves each dish's relative share of a macro while correcting the total to match exactly", () => {
    // Dish A claims 150g protein, dish B claims 50g (a real 3:1 concentration
    // decision) but the real aggregate is 210g, not their stated 200g sum.
    const raw = [
      { calories: 700, proteinG: 150, carbsG: 60, fatG: 20 },
      { calories: 500, proteinG: 50, carbsG: 80, fatG: 15 },
    ];
    const aggregate = { calories: 1200, proteinG: 210, carbsG: 140, fatG: 35 };
    const rescaled = rescaleToAggregate(raw, aggregate);

    const totalProtein = rescaled[0].proteinG + rescaled[1].proteinG;
    expect(totalProtein).toBeCloseTo(210, 5);
    // The 3:1 ratio survives the correction.
    expect(rescaled[0].proteinG / rescaled[1].proteinG).toBeCloseTo(3, 5);
  });

  it("is a no-op when the stated sum already matches the aggregate exactly", () => {
    const raw = [{ calories: 500, proteinG: 30, carbsG: 50, fatG: 15 }];
    const aggregate = { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 };
    expect(rescaleToAggregate(raw, aggregate)).toEqual(raw);
  });

  it("does not divide by zero when a stated macro sums to zero across all dishes", () => {
    const raw = [{ calories: 500, proteinG: 0, carbsG: 50, fatG: 15 }];
    const aggregate = { calories: 500, proteinG: 30, carbsG: 50, fatG: 15 };
    const rescaled = rescaleToAggregate(raw, aggregate);
    expect(rescaled[0].proteinG).toBe(0);
    expect(Number.isFinite(rescaled[0].proteinG)).toBe(true);
  });
});
