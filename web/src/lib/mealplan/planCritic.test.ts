import { describe, it, expect } from "vitest";
import { validateCritique } from "./planCritic";

describe("validateCritique", () => {
  it("accepts a well-formed critique", () => {
    const raw = {
      overallAssessment: "Good variety overall, but Cottage Cheese + Banana repeats too often.",
      flaggedSlots: [
        { dayIndex: 2, mealType: "lunch", reason: "repetitive", note: "This recipe already appears 3 times this week." },
        { dayIndex: 5, mealType: "dinner", reason: "macro_miss", note: "Protein is 40% under target for this meal." },
      ],
    };
    const result = validateCritique(raw);
    expect(result).not.toBeNull();
    expect(result!.flaggedSlots).toHaveLength(2);
    expect(result!.flaggedSlots[0].reason).toBe("repetitive");
  });

  it("accepts a critique with zero flagged slots", () => {
    const raw = { overallAssessment: "Everything looks good.", flaggedSlots: [] };
    const result = validateCritique(raw);
    expect(result).not.toBeNull();
    expect(result!.flaggedSlots).toHaveLength(0);
  });

  it("rejects a missing overallAssessment", () => {
    expect(validateCritique({ flaggedSlots: [] })).toBeNull();
  });

  it("rejects a non-array flaggedSlots", () => {
    expect(validateCritique({ overallAssessment: "x", flaggedSlots: "none" })).toBeNull();
  });

  it("rejects an out-of-range dayIndex", () => {
    const raw = {
      overallAssessment: "x",
      flaggedSlots: [{ dayIndex: 7, mealType: "lunch", reason: "repetitive", note: "n" }],
    };
    expect(validateCritique(raw)).toBeNull();
  });

  it("rejects an invalid mealType", () => {
    const raw = {
      overallAssessment: "x",
      flaggedSlots: [{ dayIndex: 0, mealType: "brunch", reason: "repetitive", note: "n" }],
    };
    expect(validateCritique(raw)).toBeNull();
  });

  it("rejects an invalid reason", () => {
    const raw = {
      overallAssessment: "x",
      flaggedSlots: [{ dayIndex: 0, mealType: "lunch", reason: "bad_vibes", note: "n" }],
    };
    expect(validateCritique(raw)).toBeNull();
  });

  // Added July 16 2026, per plan-critic-diet-violation-spec-2026-07-16.md.
  it("accepts a diet_violation reason", () => {
    const raw = {
      overallAssessment: "One meal contains a hidden animal product.",
      flaggedSlots: [
        { dayIndex: 3, mealType: "dinner", reason: "diet_violation", note: "Uses fish sauce (nam pla), violates the vegan diet." },
      ],
    };
    const result = validateCritique(raw);
    expect(result).not.toBeNull();
    expect(result!.flaggedSlots[0].reason).toBe("diet_violation");
  });

  it("rejects null or non-object input", () => {
    expect(validateCritique(null)).toBeNull();
    expect(validateCritique("a string")).toBeNull();
  });
});
