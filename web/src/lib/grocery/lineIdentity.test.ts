import { describe, it, expect } from "vitest";
import { buildNameComponents, parseLineMatchResponse, isFullClique, partitionConfirmedCliques, buildIdRemap } from "./lineIdentity";

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

  // Grocery-duplicates investigation, 2026-07-31: "bell pepper" and "red
  // pepper" never share a substring relationship either direction, so they
  // never became identity-match candidates at all -- live-confirmed zero
  // rows for this exact pair in the production ingredient_line_identity_
  // matches cache table, a candidate-generation gap, not a wrong cached
  // answer. Widening what's worth asking about never changes what merges
  // (isFullClique's own LLM-confirmed judgment still gates that).
  it("connects two multi-word names sharing only their LAST word (different leading modifier)", () => {
    const { componentsNeedingConfirmation } = buildNameComponents([
      { id: 5, name: "Bell Pepper" },
      { id: 6, name: "Red Pepper" },
    ]);
    expect(componentsNeedingConfirmation).toHaveLength(1);
    expect(new Set(componentsNeedingConfirmation[0])).toEqual(new Set(["bell pepper", "red pepper"]));
  });

  it("does not connect names sharing only their FIRST word (different product)", () => {
    const { componentsNeedingConfirmation } = buildNameComponents([
      { id: 5, name: "Tomato Paste" },
      { id: 6, name: "Tomato Sauce" },
    ]);
    expect(componentsNeedingConfirmation).toEqual([]);
  });

  it("does not connect a single-word name with a multi-word name sharing only a middle/last word (already covered by containment, not by this rule)", () => {
    // "cayenne" is one word -- if it were also a suffix of some other
    // multi-word name that's a genuinely different case (containment),
    // not the last-word rule this test is scoping.
    const { componentsNeedingConfirmation } = buildNameComponents([
      { id: 5, name: "Cayenne" },
      { id: 6, name: "Ground Cayenne Pepper" },
    ]);
    // "cayenne" IS contained in "ground cayenne pepper" as a whole word,
    // so containment (not the last-word rule) correctly connects these --
    // confirms the last-word rule isn't needed here, not that it's absent.
    expect(componentsNeedingConfirmation).toHaveLength(1);
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

describe("partitionConfirmedCliques", () => {
  it("still merges nothing for the classic hub-bridge case (broth is ambiguous between two exclusive pairs)", () => {
    const names = ["chicken broth", "broth", "vegetable broth"];
    const partiallyConfirmed = new Set(["broth||chicken broth", "broth||vegetable broth"]);
    expect(partitionConfirmedCliques(names, partiallyConfirmed)).toEqual([]);
  });

  it("merges a fully-confirmed 3-name clique in full", () => {
    const names = ["a broth", "broth", "b broth"];
    const allConfirmed = new Set(["a broth||b broth", "a broth||broth", "b broth||broth"]);
    const result = partitionConfirmedCliques(names, allConfirmed);
    expect(result).toHaveLength(1);
    expect(new Set(result[0])).toEqual(new Set(names));
  });

  it("merges a verified subgroup even when a differently-prepared variant in the same candidate component was correctly rejected", () => {
    // Live-confirmed 2026-07-31 shape: "chicken breast"/"chicken breasts"/
    // "chicken breast halves boned and skinned" are the same raw product
    // (verified full triangle); "cooked chicken breast" is a genuinely
    // different physical quantity (moisture loss from cooking) and was
    // correctly never confirmed against any of the other three. The old
    // all-or-nothing isFullClique gate would have merged NOTHING here.
    const names = ["chicken breast", "chicken breasts", "chicken breast halves boned and skinned", "cooked chicken breast"];
    // pairKey internally alphabetizes each pair -- both orderings are added
    // here so this test doesn't depend on getting that alphabetization
    // right by hand for a long, easy-to-miscompare string.
    const confirmed = new Set([
      "chicken breast||chicken breasts",
      "chicken breasts||chicken breast",
      "chicken breast||chicken breast halves boned and skinned",
      "chicken breast halves boned and skinned||chicken breast",
      "chicken breasts||chicken breast halves boned and skinned",
      "chicken breast halves boned and skinned||chicken breasts",
    ]);
    const result = partitionConfirmedCliques(names, confirmed);
    expect(result).toHaveLength(1);
    expect(new Set(result[0])).toEqual(new Set(["chicken breast", "chicken breasts", "chicken breast halves boned and skinned"]));
  });

  it("excludes an ambiguous hub from both groups but still merges the rest of each group", () => {
    // "chicken breast" confirmed-matches both a 2-name group ("chicken")
    // and a 3-name group ("chicken breasts"/"...boned and skinned") that do
    // NOT confirm with each other -- "chicken breast" itself is the
    // ambiguous hub and merges with neither, but "chicken breasts" and
    // "...boned and skinned" (confirmed with each other directly) still
    // merge as their own pair.
    const names = ["chicken", "chicken breast", "chicken breasts", "chicken breast halves boned and skinned"];
    // Both orderings included per-pair, same reasoning as the test above.
    const confirmed = new Set([
      "chicken||chicken breast",
      "chicken breast||chicken",
      "chicken breast||chicken breasts",
      "chicken breasts||chicken breast",
      "chicken breast||chicken breast halves boned and skinned",
      "chicken breast halves boned and skinned||chicken breast",
      "chicken breasts||chicken breast halves boned and skinned",
      "chicken breast halves boned and skinned||chicken breasts",
    ]);
    const result = partitionConfirmedCliques(names, confirmed);
    expect(result).toHaveLength(1);
    expect(new Set(result[0])).toEqual(new Set(["chicken breasts", "chicken breast halves boned and skinned"]));
  });

  it("returns no groups when nothing at all was confirmed", () => {
    expect(partitionConfirmedCliques(["onion", "green onion"], new Set())).toEqual([]);
  });

  it("merges two fully disjoint qualifying cliques found within one call independently", () => {
    const names = ["a", "b", "c", "d", "e"];
    const confirmed = new Set(["a||b", "b||a", "d||e", "e||d"]);
    const result = partitionConfirmedCliques(names, confirmed);
    expect(result).toHaveLength(2);
    const sets = result.map((g) => new Set(g));
    expect(sets).toContainEqual(new Set(["a", "b"]));
    expect(sets).toContainEqual(new Set(["d", "e"]));
  });

  it("merges nothing at all for a linear chain with no triangle anywhere -- every interior node is an ambiguous hub", () => {
    // a-b, b-c, c-d confirmed; a-c, b-d, a-d never confirmed. b sits in
    // both {a,b} and {b,c}; c sits in both {b,c} and {c,d} -- both are
    // ambiguous hubs, which leaves every 2-clique with at most one
    // unambiguous member, so nothing clears the size-2 bar.
    const names = ["a", "b", "c", "d"];
    const confirmed = new Set(["a||b", "b||a", "b||c", "c||b", "c||d", "d||c"]);
    expect(partitionConfirmedCliques(names, confirmed)).toEqual([]);
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
