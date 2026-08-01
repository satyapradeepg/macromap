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

  // Live-confirmed 2026-08-01 (end-to-end test of the deployed app): this
  // exact 7-word leak (a recipe title + serving-size label fragment) fell
  // one word short of the original 8-word threshold and reached a real
  // generated grocery list untouched -- the threshold was lowered to 7
  // the same day this was found (see this file's own header comment).
  it("flags the live-confirmed 7-word leak that motivated lowering the threshold from 8 to 7", () => {
    expect(needsAiNameCheck("sundried tomato & artichoke tuna casserole: serves")).toBe(true);
  });

  it("is exactly at the threshold boundary (7 words triggers, 6 does not)", () => {
    expect(needsAiNameCheck("one two three four five six")).toBe(false);
    expect(needsAiNameCheck("one two three four five six seven")).toBe(true);
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
