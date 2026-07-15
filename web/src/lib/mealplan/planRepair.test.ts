import { describe, it, expect } from "vitest";
import { shouldAcceptRepair } from "./planRepair";

describe("shouldAcceptRepair", () => {
  it("accepts a macro_miss repair when the new candidate is meaningfully closer to target", () => {
    const accept = shouldAcceptRepair({
      reason: "macro_miss",
      oldScore: 0.8,
      newScore: 0.2,
      otherTitlesInPlan: ["Some Other Dish"],
      newCandidateTitle: "Better Fit Dish",
    });
    expect(accept).toBe(true);
  });

  it("rejects when the new candidate is worse (higher deviation score)", () => {
    const accept = shouldAcceptRepair({
      reason: "macro_miss",
      oldScore: 0.2,
      newScore: 0.8,
      otherTitlesInPlan: [],
      newCandidateTitle: "Worse Fit Dish",
    });
    expect(accept).toBe(false);
  });

  it("rejects when the improvement is within floating-point noise (not meaningfully better)", () => {
    const accept = shouldAcceptRepair({
      reason: "macro_miss",
      oldScore: 0.2,
      newScore: 0.1995, // improvement of 0.0005, well under the 0.01 threshold
      otherTitlesInPlan: [],
      newCandidateTitle: "Marginally Different Dish",
    });
    expect(accept).toBe(false);
  });

  it("rejects a repetitive-reason swap when the new candidate is ALSO already used elsewhere", () => {
    // Swapping one duplicate for a different duplicate doesn't resolve
    // what was actually flagged.
    const accept = shouldAcceptRepair({
      reason: "repetitive",
      oldScore: 0.8,
      newScore: 0.1,
      otherTitlesInPlan: ["Chicken Stir Fry", "Chicken Stir Fry", "Something Else"],
      newCandidateTitle: "Chicken Stir Fry",
    });
    expect(accept).toBe(false);
  });

  it("accepts a repetitive-reason swap when the new candidate is genuinely distinct", () => {
    const accept = shouldAcceptRepair({
      reason: "repetitive",
      oldScore: 0.8,
      newScore: 0.1,
      otherTitlesInPlan: ["Chicken Stir Fry", "Chicken Stir Fry", "Something Else"],
      newCandidateTitle: "Lentil Soup",
    });
    expect(accept).toBe(true);
  });

  it("still requires a real macro improvement for a repetitive-reason swap, not just distinctness", () => {
    const accept = shouldAcceptRepair({
      reason: "repetitive",
      oldScore: 0.1,
      newScore: 0.5, // worse fit, even though it's distinct
      otherTitlesInPlan: ["Chicken Stir Fry"],
      newCandidateTitle: "Lentil Soup",
    });
    expect(accept).toBe(false);
  });

  it("accepts an 'other' reason repair on the same terms as macro_miss", () => {
    const accept = shouldAcceptRepair({
      reason: "other",
      oldScore: 0.6,
      newScore: 0.1,
      otherTitlesInPlan: ["Something"],
      newCandidateTitle: "Something New",
    });
    expect(accept).toBe(true);
  });
});
