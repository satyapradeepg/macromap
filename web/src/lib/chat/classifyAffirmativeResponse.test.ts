import { describe, it, expect } from "vitest";
import { classifyAffirmativeResponse } from "./classifyAffirmativeResponse";

describe("classifyAffirmativeResponse", () => {
  it("recognizes clear affirmative responses", () => {
    expect(classifyAffirmativeResponse("yes")).toBe(true);
    expect(classifyAffirmativeResponse("Yes!")).toBe(true);
    expect(classifyAffirmativeResponse("yeah do that")).toBe(true);
    expect(classifyAffirmativeResponse("sure")).toBe(true);
    expect(classifyAffirmativeResponse("go ahead")).toBe(true);
    expect(classifyAffirmativeResponse("Okay.")).toBe(true);
  });

  it("recognizes clear negative responses", () => {
    expect(classifyAffirmativeResponse("no")).toBe(false);
    expect(classifyAffirmativeResponse("No thanks")).toBe(false);
    expect(classifyAffirmativeResponse("nevermind")).toBe(false);
    expect(classifyAffirmativeResponse("cancel that")).toBe(false);
  });

  it("falls through (null) on anything ambiguous or unrelated", () => {
    expect(classifyAffirmativeResponse("swap tomorrow's dinner instead")).toBeNull();
    expect(classifyAffirmativeResponse("maybe")).toBeNull();
    expect(classifyAffirmativeResponse("")).toBeNull();
  });

  it("is case-insensitive and tolerant of trailing punctuation", () => {
    expect(classifyAffirmativeResponse("YES!!")).toBe(true);
    expect(classifyAffirmativeResponse("No.")).toBe(false);
  });
});
