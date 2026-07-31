import { describe, it, expect } from "vitest";
import { needsAiNameCheck, parseNameRepairResponse } from "./nameRepair";

describe("needsAiNameCheck", () => {
  it("does not flag real, even verbose, Spoonacular ingredient descriptors", () => {
    expect(needsAiNameCheck("chicken breast halves boned and skinned")).toBe(false);
    expect(needsAiNameCheck("boned and skinned chicken breast halves")).toBe(false);
    expect(needsAiNameCheck("chicken breast")).toBe(false);
  });

  it("flags live-confirmed free-text leaks", () => {
    expect(needsAiNameCheck("this healthy cranberry pecan greek yogurt chicken salad is easy")).toBe(true);
    expect(needsAiNameCheck("herbs - i use 1 sprig of thyme & a bay")).toBe(true);
  });

  it("is exactly at the threshold boundary (8 words triggers, 7 does not)", () => {
    expect(needsAiNameCheck("one two three four five six seven")).toBe(false);
    expect(needsAiNameCheck("one two three four five six seven eight")).toBe(true);
  });

  it("collapses extra whitespace rather than over-counting", () => {
    expect(needsAiNameCheck("chicken   breast    halves  boned   and   skinned")).toBe(false);
  });
});

describe("parseNameRepairResponse", () => {
  it("accepts a clean outcome with no repairedName needed", () => {
    expect(parseNameRepairResponse({ outcome: "clean" })).toEqual({ outcome: "clean", repairedName: null });
  });

  it("accepts a reject outcome with no repairedName needed", () => {
    expect(parseNameRepairResponse({ outcome: "reject" })).toEqual({ outcome: "reject", repairedName: null });
  });

  it("accepts a repaired outcome with a valid repairedName, trimmed", () => {
    expect(parseNameRepairResponse({ outcome: "repaired", repairedName: " thyme " })).toEqual({
      outcome: "repaired",
      repairedName: "thyme",
    });
  });

  it("rejects a repaired outcome missing or with an empty repairedName", () => {
    expect(parseNameRepairResponse({ outcome: "repaired" })).toBeNull();
    expect(parseNameRepairResponse({ outcome: "repaired", repairedName: "   " })).toBeNull();
    expect(parseNameRepairResponse({ outcome: "repaired", repairedName: 42 })).toBeNull();
  });

  it("rejects an invalid or missing outcome value", () => {
    expect(parseNameRepairResponse({ outcome: "maybe" })).toBeNull();
    expect(parseNameRepairResponse({})).toBeNull();
  });

  it("rejects null or non-object input", () => {
    expect(parseNameRepairResponse(null)).toBeNull();
    expect(parseNameRepairResponse("a string")).toBeNull();
  });
});
