import { describe, it, expect } from "vitest";
import { recipeCacheKey, isStale } from "./cacheKey";

const baseSig = {
  minProtein: 36,
  maxProtein: 44,
  minCalories: 450,
  maxCalories: 550,
  diet: "vegan",
  intolerances: ["Gluten"],
  excludeIngredients: ["Peanuts", "shellfish"],
  resultCount: 30,
  type: "main course",
};

describe("recipeCacheKey", () => {
  it("is stable regardless of excludeIngredients ordering or casing", () => {
    const a = recipeCacheKey(baseSig);
    const b = recipeCacheKey({ ...baseSig, excludeIngredients: ["Shellfish", "peanuts"] });
    expect(a).toBe(b);
  });

  it("is stable regardless of intolerances ordering or casing", () => {
    const a = recipeCacheKey({ ...baseSig, intolerances: ["Gluten", "Dairy"] });
    const b = recipeCacheKey({ ...baseSig, intolerances: ["dairy", "gluten"] });
    expect(a).toBe(b);
  });

  it("differs when intolerances differ — this was previously missing from the hash entirely", () => {
    const a = recipeCacheKey(baseSig);
    const b = recipeCacheKey({ ...baseSig, intolerances: [] });
    expect(a).not.toBe(b);
  });

  it("differs when diet differs", () => {
    const a = recipeCacheKey(baseSig);
    const b = recipeCacheKey({ ...baseSig, diet: undefined });
    expect(a).not.toBe(b);
  });

  it("differs when resultCount differs, so tuning the pool size can't silently serve a stale smaller pool from cache", () => {
    const a = recipeCacheKey(baseSig);
    const b = recipeCacheKey({ ...baseSig, resultCount: 8 });
    expect(a).not.toBe(b);
  });

  it("differs when type differs — breakfast and main course must not share a cache entry", () => {
    const a = recipeCacheKey(baseSig);
    const b = recipeCacheKey({ ...baseSig, type: "breakfast" });
    expect(a).not.toBe(b);
  });

  it("is insensitive to floating-point noise in bounds", () => {
    const a = recipeCacheKey(baseSig);
    const b = recipeCacheKey({ ...baseSig, minProtein: 36.00000001 });
    expect(a).toBe(b);
  });
});

describe("isStale", () => {
  it("is not stale immediately after fetching", () => {
    const now = new Date("2026-07-13T00:00:00Z");
    expect(isStale(now, now)).toBe(false);
  });

  it("is stale after 7 days", () => {
    const fetchedAt = new Date("2026-07-01T00:00:00Z");
    const now = new Date("2026-07-09T00:00:00Z");
    expect(isStale(fetchedAt, now)).toBe(true);
  });

  it("is not stale just under 7 days later", () => {
    const fetchedAt = new Date("2026-07-01T00:00:00Z");
    const now = new Date("2026-07-07T00:00:00Z");
    expect(isStale(fetchedAt, now)).toBe(false);
  });
});
