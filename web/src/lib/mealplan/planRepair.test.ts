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

  // Safety-first exception, added July 16 2026 -- see
  // plan-critic-diet-violation-spec-2026-07-16.md. The caller only ever
  // invokes this with a real, already-safety-filtered replacement
  // candidate in hand, so a diet_violation repair always accepts it,
  // even at a real macro-fit cost.
  describe("diet_violation safety-first exception", () => {
    it("accepts a diet_violation repair even when the new candidate is a WORSE macro fit", () => {
      const accept = shouldAcceptRepair({
        reason: "diet_violation",
        oldScore: 0.1, // the violating meal was actually a near-perfect macro fit
        newScore: 0.9, // the safe alternative is a much worse fit
        otherTitlesInPlan: [],
        newCandidateTitle: "Safe Alternative Dish",
      });
      expect(accept).toBe(true);
    });

    it("accepts a diet_violation repair even when the new candidate duplicates another slot in the plan", () => {
      // Unlike "repetitive", diet_violation has no duplication check --
      // safety always wins, a repeated-but-safe dish beats a violation.
      const accept = shouldAcceptRepair({
        reason: "diet_violation",
        oldScore: 0.1,
        newScore: 0.5,
        otherTitlesInPlan: ["Lentil Soup", "Lentil Soup"],
        newCandidateTitle: "Lentil Soup",
      });
      expect(accept).toBe(true);
    });

    it("accepts a diet_violation repair on a tie or negative improvement, unlike every other reason", () => {
      const accept = shouldAcceptRepair({
        reason: "diet_violation",
        oldScore: 0.2,
        newScore: 0.2000001, // effectively identical, would fail every other reason's threshold
        otherTitlesInPlan: [],
        newCandidateTitle: "Safe Alternative Dish",
      });
      expect(accept).toBe(true);
    });
  });
});
