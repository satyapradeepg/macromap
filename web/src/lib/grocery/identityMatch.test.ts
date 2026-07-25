import { describe, it, expect } from "vitest";
import { parseMatchResponse } from "./identityMatch";

describe("parseMatchResponse", () => {
  it("accepts a well-formed matches list", () => {
    const result = parseMatchResponse({ matches: ["yellow onion", "onion"] }, ["yellow onion", "onion", "green onions"]);
    expect(result).not.toBeNull();
    expect(result).toEqual(new Set(["yellow onion", "onion"]));
  });

  it("accepts an empty matches list", () => {
    const result = parseMatchResponse({ matches: [] }, ["onion"]);
    expect(result).toEqual(new Set());
  });

  it("normalizes case and whitespace on both sides before comparing", () => {
    const result = parseMatchResponse({ matches: ["  Yellow Onion  "] }, ["yellow onion"]);
    expect(result).toEqual(new Set(["yellow onion"]));
  });

  // The whole point of restricting to the candidate set: a hallucinated or
  // reworded name from the model must never silently produce a match
  // against something that was never actually asked about.
  it("drops a match that isn't one of the real candidates", () => {
    const result = parseMatchResponse({ matches: ["onion", "garlic"] }, ["onion"]);
    expect(result).toEqual(new Set(["onion"]));
  });

  it("rejects a missing matches field", () => {
    expect(parseMatchResponse({}, ["onion"])).toBeNull();
  });

  it("rejects a non-array matches field", () => {
    expect(parseMatchResponse({ matches: "onion" }, ["onion"])).toBeNull();
  });

  it("filters out non-string entries rather than rejecting the whole response", () => {
    const result = parseMatchResponse({ matches: ["onion", 42, null] }, ["onion"]);
    expect(result).toEqual(new Set(["onion"]));
  });

  it("rejects null or non-object input", () => {
    expect(parseMatchResponse(null, ["onion"])).toBeNull();
    expect(parseMatchResponse("a string", ["onion"])).toBeNull();
  });
});
