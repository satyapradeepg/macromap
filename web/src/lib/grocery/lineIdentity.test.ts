import { describe, it, expect } from "vitest";
import { buildNameComponents, parseLineMatchResponse, isFullClique, buildIdRemap } from "./lineIdentity";

describe("buildNameComponents", () => {
  it("groups different ids sharing the exact same normalized name, no LLM needed", () => {
    const { namesToIds, componentsNeedingConfirmation } = buildNameComponents([
      { id: 5, name: "Garlic" },
      { id: 6, name: "garlic" },
      { id: 7, name: "  Garlic  " },
    ]);
    expect(namesToIds.get("garlic")).toEqual(new Set([5, 6, 7]));
    expect(componentsNeedingConfirmation).toEqual([]);
  });

  it("connects different names that overlap by word boundary into a component needing confirmation", () => {
    const { componentsNeedingConfirmation } = buildNameComponents([
      { id: 5, name: "Garlic" },
      { id: 6, name: "Garlic Cloves" },
    ]);
    expect(componentsNeedingConfirmation).toHaveLength(1);
    expect(new Set(componentsNeedingConfirmation[0])).toEqual(new Set(["garlic", "garlic cloves"]));
  });

  it("does not connect names with no word-boundary overlap at all", () => {
    const { componentsNeedingConfirmation } = buildNameComponents([
      { id: 5, name: "Chicken Breast" },
      { id: 6, name: "Banana" },
    ]);
    expect(componentsNeedingConfirmation).toEqual([]);
  });

  it("transitively connects a 3-name component via a shared hub word (e.g. 'broth') into ONE component to investigate", () => {
    // Connectivity here only decides what's worth ASKING about -- it does
    // NOT mean these three will merge. isFullClique (tested below) is what
    // actually gates the merge decision.
    const { componentsNeedingConfirmation } = buildNameComponents([
      { id: 1, name: "Chicken Broth" },
      { id: 2, name: "Broth" },
      { id: 3, name: "Vegetable Broth" },
    ]);
    expect(componentsNeedingConfirmation).toHaveLength(1);
    expect(new Set(componentsNeedingConfirmation[0])).toEqual(new Set(["chicken broth", "broth", "vegetable broth"]));
  });

  it("excludes invalid/placeholder ids entirely", () => {
    const { namesToIds, componentsNeedingConfirmation } = buildNameComponents([
      { id: -1, name: "mayonaisse" },
      { id: -1, name: "or" },
      { id: 5, name: "Onion" },
    ]);
    expect(namesToIds.has("mayonaisse")).toBe(false);
    expect(namesToIds.has("or")).toBe(false);
    expect(namesToIds.get("onion")).toEqual(new Set([5]));
    expect(componentsNeedingConfirmation).toEqual([]);
  });

  it("keeps disjoint components separate", () => {
    // "chicken broth" and "broth" connect directly (whole-word overlap),
    // same as "garlic"/"garlic cloves" -- but the two pairs share no word
    // with each other, so they must resolve as two independent components.
    const { componentsNeedingConfirmation } = buildNameComponents([
      { id: 1, name: "Garlic" },
      { id: 2, name: "Garlic Cloves" },
      { id: 3, name: "Chicken Broth" },
      { id: 4, name: "Broth" },
    ]);
    expect(componentsNeedingConfirmation).toHaveLength(2);
    const sets = componentsNeedingConfirmation.map((c) => new Set(c));
    expect(sets).toContainEqual(new Set(["garlic", "garlic cloves"]));
    expect(sets).toContainEqual(new Set(["chicken broth", "broth"]));
  });
});

describe("parseLineMatchResponse", () => {
  it("accepts a well-formed matches list", () => {
    const result = parseLineMatchResponse({ matches: ["garlic cloves"] }, ["garlic cloves", "garlic powder"]);
    expect(result).toEqual(new Set(["garlic cloves"]));
  });

  it("drops a match that isn't one of the real candidates", () => {
    const result = parseLineMatchResponse({ matches: ["garlic cloves", "shallot"] }, ["garlic cloves"]);
    expect(result).toEqual(new Set(["garlic cloves"]));
  });

  it("rejects a missing or non-array matches field", () => {
    expect(parseLineMatchResponse({}, ["garlic"])).toBeNull();
    expect(parseLineMatchResponse({ matches: "garlic" }, ["garlic"])).toBeNull();
  });

  it("rejects null or non-object input", () => {
    expect(parseLineMatchResponse(null, ["garlic"])).toBeNull();
    expect(parseLineMatchResponse("a string", ["garlic"])).toBeNull();
  });

  it("filters out non-string entries rather than rejecting the whole response", () => {
    const result = parseLineMatchResponse({ matches: ["garlic", 42, null] }, ["garlic"]);
    expect(result).toEqual(new Set(["garlic"]));
  });
});

describe("isFullClique", () => {
  it("is true for a 2-name component with the one required pair confirmed", () => {
    const confirmed = new Set(["garlic||garlic cloves"]);
    expect(isFullClique(["garlic", "garlic cloves"], confirmed)).toBe(true);
  });

  it("is false for a 2-name component with no confirmation", () => {
    expect(isFullClique(["onion", "green onion"], new Set())).toBe(false);
  });

  it("is true for a 3-name component only when EVERY pair is confirmed", () => {
    const names = ["a broth", "broth", "b broth"];
    const allConfirmed = new Set(["a broth||b broth", "a broth||broth", "b broth||broth"]);
    expect(isFullClique(names, allConfirmed)).toBe(true);
  });

  // The hub-bridge risk this design exists to prevent: A-B and B-C
  // confirmed, but A-C was never confirmed (or was rejected) -- must NOT
  // be treated as a clique.
  it("is false for a hub-bridge component where the non-hub pair was never confirmed", () => {
    const names = ["chicken broth", "broth", "vegetable broth"];
    const partiallyConfirmed = new Set(["broth||chicken broth", "broth||vegetable broth"]);
    expect(isFullClique(names, partiallyConfirmed)).toBe(false);
  });
});

describe("buildIdRemap", () => {
  it("maps every id to itself when nothing merges", () => {
    const namesToIds = new Map([
      ["onion", new Set([5])],
      ["banana", new Set([6])],
    ]);
    const remap = buildIdRemap(namesToIds, []);
    expect(remap.get(5)).toBe(5);
    expect(remap.get(6)).toBe(6);
  });

  it("merges ids sharing the exact same name to the lowest id, with no qualifying components needed", () => {
    const namesToIds = new Map([["garlic", new Set([7, 5, 6])]]);
    const remap = buildIdRemap(namesToIds, []);
    expect(remap.get(5)).toBe(5);
    expect(remap.get(6)).toBe(5);
    expect(remap.get(7)).toBe(5);
  });

  it("merges a clique-confirmed multi-name component's ids to the lowest id across the whole group", () => {
    const namesToIds = new Map([
      ["garlic", new Set([9])],
      ["garlic cloves", new Set([3])],
    ]);
    const remap = buildIdRemap(namesToIds, [["garlic", "garlic cloves"]]);
    expect(remap.get(9)).toBe(3);
    expect(remap.get(3)).toBe(3);
  });

  it("leaves a non-qualifying (rejected clique) component's ids unmapped to each other", () => {
    const namesToIds = new Map([
      ["chicken broth", new Set([1])],
      ["broth", new Set([2])],
      ["vegetable broth", new Set([3])],
    ]);
    // Component not passed as qualifying -- e.g. isFullClique returned false.
    const remap = buildIdRemap(namesToIds, []);
    expect(remap.get(1)).toBe(1);
    expect(remap.get(2)).toBe(2);
    expect(remap.get(3)).toBe(3);
  });
});
