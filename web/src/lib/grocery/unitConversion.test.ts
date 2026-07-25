import { describe, it, expect } from "vitest";
import { parseEstimateResponse } from "./unitConversion";

describe("parseEstimateResponse", () => {
  it("accepts a well-formed positive rate", () => {
    expect(parseEstimateResponse({ targetPerSource: 1.03 })).toBe(1.03);
  });

  it("rejects a missing targetPerSource field", () => {
    expect(parseEstimateResponse({})).toBeNull();
  });

  it("rejects a non-numeric targetPerSource", () => {
    expect(parseEstimateResponse({ targetPerSource: "1.03" })).toBeNull();
  });

  it("rejects zero or negative rates -- never physically meaningful", () => {
    expect(parseEstimateResponse({ targetPerSource: 0 })).toBeNull();
    expect(parseEstimateResponse({ targetPerSource: -2 })).toBeNull();
  });

  it("rejects non-finite values", () => {
    expect(parseEstimateResponse({ targetPerSource: Infinity })).toBeNull();
    expect(parseEstimateResponse({ targetPerSource: NaN })).toBeNull();
  });

  it("rejects null or non-object input", () => {
    expect(parseEstimateResponse(null)).toBeNull();
    expect(parseEstimateResponse("a string")).toBeNull();
  });
});
