import { describe, it, expect } from "vitest";
import { applyProfileOperations, type ProfileFields } from "./applyProfileOperations";

function baseFields(overrides: Partial<ProfileFields> = {}): ProfileFields {
  return {
    weightKg: 80,
    heightCm: 180,
    age: 30,
    biologicalSex: "male",
    activityLevel: "active",
    goal: "maintain",
    dietaryStyles: ["vegetarian"],
    allergies: ["peanuts"],
    dislikes: ["cilantro"],
    ...overrides,
  };
}

describe("applyProfileOperations", () => {
  it("adds a new allergy without touching other fields", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "allergies", action: "add", value: "shellfish" }]);
    expect(result.error).toBeNull();
    expect(result.fields.allergies).toEqual(["peanuts", "shellfish"]);
    expect(result.fields.dietaryStyles).toEqual(["vegetarian"]);
    expect(result.scalarsChanged).toBe(false);
  });

  it("is a no-op (case-insensitive) when adding an allergy that's already present", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "allergies", action: "add", value: "Peanuts" }]);
    expect(result.fields.allergies).toEqual(["peanuts"]);
  });

  it("removes a dislike case-insensitively", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "dislikes", action: "remove", value: "Cilantro" }]);
    expect(result.fields.dislikes).toEqual([]);
  });

  it("removing something not present is a harmless no-op", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "allergies", action: "remove", value: "tree nuts" }]);
    expect(result.fields.allergies).toEqual(["peanuts"]);
    expect(result.error).toBeNull();
  });

  it("normalizes and adds a recognized dietary style", () => {
    const result = applyProfileOperations(baseFields({ dietaryStyles: [] }), [
      { field: "dietaryStyles", action: "add", value: "Gluten Free" },
    ]);
    expect(result.error).toBeNull();
    expect(result.fields.dietaryStyles).toEqual(["gluten_free"]);
  });

  it("rejects an unrecognized dietary style and discards ALL changes in the batch", () => {
    const result = applyProfileOperations(baseFields(), [
      { field: "allergies", action: "add", value: "sesame" },
      { field: "dietaryStyles", action: "add", value: "paleo" },
    ]);
    expect(result.error).toMatch(/isn't a dietary style/);
    expect(result.fields).toEqual(baseFields()); // the sesame allergy add before the bad op was discarded too
  });

  it("converts a weight in lbs to kg and marks scalarsChanged", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "weightKg", action: "set", value: "176" }]);
    expect(result.error).toBeNull();
    expect(result.fields.weightKg).toBeCloseTo(79.82, 1); // 176 lbs
    expect(result.scalarsChanged).toBe(true);
  });

  it("rejects a weight outside the realistic range", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "weightKg", action: "set", value: "5" }]);
    expect(result.error).toMatch(/Weight must be between/);
    expect(result.fields).toEqual(baseFields());
  });

  it("converts a height in inches to cm", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "heightCm", action: "set", value: "70" }]);
    expect(result.error).toBeNull();
    expect(result.fields.heightCm).toBeCloseTo(177.8, 1);
    expect(result.scalarsChanged).toBe(true);
  });

  it("rejects a non-numeric age", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "age", action: "set", value: "young" }]);
    expect(result.error).toMatch(/Age must be between/);
  });

  it("normalizes an activity level with spaces to the underscore enum form", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "activityLevel", action: "set", value: "lightly active" }]);
    expect(result.error).toBeNull();
    expect(result.fields.activityLevel).toBe("lightly_active");
  });

  it("rejects an unrecognized goal", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "goal", action: "set", value: "shred" }]);
    expect(result.error).toMatch(/isn't a goal I recognize/);
  });

  it("sets biological sex", () => {
    const result = applyProfileOperations(baseFields(), [{ field: "biologicalSex", action: "set", value: "female" }]);
    expect(result.fields.biologicalSex).toBe("female");
    expect(result.scalarsChanged).toBe(true);
  });

  it("applies multiple valid operations together", () => {
    const result = applyProfileOperations(baseFields(), [
      { field: "goal", action: "set", value: "bulk" },
      { field: "allergies", action: "add", value: "eggs" },
    ]);
    expect(result.error).toBeNull();
    expect(result.fields.goal).toBe("bulk");
    expect(result.fields.allergies).toEqual(["peanuts", "eggs"]);
    expect(result.scalarsChanged).toBe(true);
  });

  it("does not mutate the arrays on the input fields object", () => {
    const input = baseFields();
    applyProfileOperations(input, [{ field: "allergies", action: "add", value: "shellfish" }]);
    expect(input.allergies).toEqual(["peanuts"]);
  });
});
