import { describe, it, expect } from "vitest";
import { validateGroceryCheck } from "./groceryCritic";

describe("validateGroceryCheck", () => {
  it("returns the note when hasConcerns is true", () => {
    const raw = { hasConcerns: true, note: "500 cloves of garlic is almost certainly a units error." };
    expect(validateGroceryCheck(raw)).toBe("500 cloves of garlic is almost certainly a units error.");
  });

  it("returns null when hasConcerns is false, even with a nonempty note", () => {
    // A well-behaved response leaves note empty when hasConcerns is false,
    // but this must not surface stray text if the model doesn't comply.
    const raw = { hasConcerns: false, note: "unexpected leftover text" };
    expect(validateGroceryCheck(raw)).toBeNull();
  });

  it("returns null for an ordinary list with no concerns", () => {
    expect(validateGroceryCheck({ hasConcerns: false, note: "" })).toBeNull();
  });

  it("returns null when hasConcerns is true but note is an empty string", () => {
    expect(validateGroceryCheck({ hasConcerns: true, note: "" })).toBeNull();
  });

  it("rejects a missing hasConcerns field", () => {
    expect(validateGroceryCheck({ note: "x" })).toBeNull();
  });

  it("rejects a non-boolean hasConcerns", () => {
    expect(validateGroceryCheck({ hasConcerns: "true", note: "x" })).toBeNull();
  });

  it("rejects a missing note field", () => {
    expect(validateGroceryCheck({ hasConcerns: true })).toBeNull();
  });

  it("rejects a non-string note", () => {
    expect(validateGroceryCheck({ hasConcerns: true, note: 42 })).toBeNull();
  });

  it("rejects a non-object input", () => {
    expect(validateGroceryCheck(null)).toBeNull();
    expect(validateGroceryCheck("x")).toBeNull();
    expect(validateGroceryCheck(undefined)).toBeNull();
  });
});
