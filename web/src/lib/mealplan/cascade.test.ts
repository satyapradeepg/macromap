import { describe, it, expect, vi } from "vitest";
import { runCascadeForSlot, matchLabelFor } from "./cascade";
import type { RecipeCandidate } from "./ranking";
import { boundsForTier } from "./tolerance";

function candidate(overrides: Partial<RecipeCandidate> = {}): RecipeCandidate {
  return {
    id: 1,
    title: "Test Recipe",
    imageUrl: null,
    servings: 1,
    proteinG: 40,
    caloriesKcal: 500,
    carbsG: 40,
    fatG: 15,
    pricePerServingCents: 300,
    aggregateLikes: 10,
    ingredients: [],
    ...overrides,
  };
}

const target = { proteinG: 40, calories: 500, carbsG: 40, fatG: 15 };
const rankOpts = { tier: "free" as const, budgetPerMealUsd: null };

describe("runCascadeForSlot", () => {
  it("fetches once at the widest (p30) bounds, not a per-tier cascade", async () => {
    const fetch = vi.fn().mockResolvedValue([candidate()]);
    const result = await runCascadeForSlot(target, fetch, rankOpts);
    expect(result.blocked).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(boundsForTier(target, "p30"), "p30");
  });

  it("labels an exact match candidate with its own real actualTier (p10)", async () => {
    const fetch = vi.fn().mockResolvedValue([candidate()]); // exact match
    const result = await runCascadeForSlot(target, fetch, rankOpts);
    expect(result.rankedCandidates[0].actualTier).toBe("p10");
  });

  it("labels a candidate outside p10 but within p20 as p20, even though it came from the p30 fetch", async () => {
    // p10 bounds: protein 36-44, calories 450-550. p20 bounds: 32-48, 400-600.
    // Protein under target, calories over target, carbs/fat exact -- picked
    // so portion scaling (ranking.ts's bestScaleAndScore) can't rescue this
    // into p10: pulling either macro toward its own breakpoint pushes the
    // other macro, and the already-exact carbs/fat, further off by more
    // than it gains, so the true score-optimum stays at scale=1.
    const fetch = vi.fn().mockResolvedValue([candidate({ proteinG: 34, caloriesKcal: 575 })]);
    const result = await runCascadeForSlot(target, fetch, rankOpts);
    expect(result.rankedCandidates[0].actualTier).toBe("p20");
  });

  it("returns blocked when the p30 fetch itself returns zero results", async () => {
    const fetch = vi.fn().mockResolvedValue([]);
    const result = await runCascadeForSlot(target, fetch, rankOpts);
    expect(result.blocked).toBe(true);
    expect(result.blockingHint).toContain("protein");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Found live July 20 2026 (extreme-max-boundary profile): the blocking
  // hint used to always say "reduce it by 10g" regardless of how far over
  // target actually was -- honest for a small miss, misleading once the
  // gap is large (a flat 10g nudge doesn't fix an 84g/meal target).
  describe("blockingHint scales with how far over target the protein actually is", () => {
    it("suggests a small, honest reduction for a target just above the typically-achievable range", async () => {
      const closeTarget = { proteinG: 58, calories: 500, carbsG: 40, fatG: 15 };
      const fetch = vi.fn().mockResolvedValue([]);
      const result = await runCascadeForSlot(closeTarget, fetch, rankOpts);
      expect(result.blockingHint).toContain("58g");
      expect(result.blockingHint).toContain("reducing it by");
      expect(result.blockingHint).not.toContain("won't fix this");
    });

    it("gives an honest structural-mismatch message instead of a fake-precise number for a far-over target", async () => {
      const extremeTarget = { proteinG: 84, calories: 1200, carbsG: 141, fatG: 33 };
      const fetch = vi.fn().mockResolvedValue([]);
      const result = await runCascadeForSlot(extremeTarget, fetch, rankOpts);
      expect(result.blockingHint).toContain("84g");
      expect(result.blockingHint).toContain("won't fix this");
      expect(result.blockingHint).not.toContain("reducing it by");
    });

    // Live-confirmed 2026-08-10, real production conversation: a user hit
    // this exact block 3 times trying to swap breakfast toward Indian
    // dishes (dosa, dosa with chicken curry, a protein curry with naan),
    // and every reply told them to try "regenerating" -- there's no
    // regenerate action reachable from a swap, and regenerating the whole
    // week is a far bigger step than the single swap they wanted.
    it("never mentions 'regenerating' for a swap-context block -- there's no regenerate action reachable from a swap", async () => {
      const closeTarget = { proteinG: 58, calories: 500, carbsG: 40, fatG: 15 };
      const fetch = vi.fn().mockResolvedValue([]);
      const result = await runCascadeForSlot(closeTarget, fetch, rankOpts, "swap");
      expect(result.blockingHint).toContain("58g");
      expect(result.blockingHint).not.toContain("regenerat");
      expect(result.blockingHint).toContain("swapping again");
    });

    it("defaults to the generation-context wording when no context is given, unchanged from before this fix", async () => {
      const closeTarget = { proteinG: 58, calories: 500, carbsG: 40, fatG: 15 };
      const fetch = vi.fn().mockResolvedValue([]);
      const result = await runCascadeForSlot(closeTarget, fetch, rankOpts);
      expect(result.blockingHint).toContain("regenerating");
    });
  });
});

describe("matchLabelFor", () => {
  it("returns null for an exact p10 match with no budget compromise", () => {
    const c = {
      ...candidate(),
      score: 0,
      budgetCompliant: true,
      actualTier: "p10" as const,
      isFallbackOfLastResort: false,
      scaleFactor: 1,
    };
    expect(matchLabelFor("p10", c, target)).toBeNull();
  });

  it("returns a delta label for a p20/p30 match", () => {
    const c = {
      ...candidate({ proteinG: 45, caloriesKcal: 550 }),
      score: 0.1,
      budgetCompliant: true,
      actualTier: "p20" as const,
      isFallbackOfLastResort: false,
      scaleFactor: 1,
    };
    const label = matchLabelFor("p20", c, target);
    expect(label).toContain("Closest match");
    expect(label).toContain("+5g protein");
  });

  it("returns a budget label for a fallback-of-last-resort candidate", () => {
    const c = {
      ...candidate({ pricePerServingCents: 450 }),
      score: 0,
      budgetCompliant: false,
      actualTier: "p10" as const,
      isFallbackOfLastResort: true,
      scaleFactor: 1,
    };
    expect(matchLabelFor("p10", c, target)).toContain("Closest to your budget");
  });

  it("returns a budget label for a demoted non-compliant candidate even when it's not the fallback of last resort", () => {
    // ranking.ts now demotes (never drops) non-compliant candidates, so a
    // slot can end up claiming one of these via collision step-down even
    // though a cheaper compliant option existed elsewhere in the list.
    const c = {
      ...candidate({ pricePerServingCents: 450 }),
      score: 0,
      budgetCompliant: false,
      actualTier: "p10" as const,
      isFallbackOfLastResort: false,
      scaleFactor: 1,
    };
    expect(matchLabelFor("p10", c, target)).toContain("Closest to your budget");
  });

  // 2026-07-30, "fill with the closest meal rather than leaving it open":
  // an approximate best-effort candidate must disclose that compromise,
  // and take priority over every other label -- it's a bigger compromise
  // than a budget miss or a loose tier, and must never be silently
  // presented as either of those instead.
  describe("isApproximate (best-effort fallback disclosure)", () => {
    it("takes priority over the budget label", () => {
      const c = {
        ...candidate({ pricePerServingCents: 450 }),
        score: 0,
        budgetCompliant: false,
        actualTier: "p10" as const,
        isFallbackOfLastResort: true,
        scaleFactor: 1,
        isApproximate: true,
        approximationNotes: ["dropped a duplicate protein ingredient"],
      };
      const label = matchLabelFor("p10", c, target);
      expect(label).toContain("Approximate");
      expect(label).not.toContain("budget");
    });

    it("takes priority over an exact p10 match (which would otherwise be null)", () => {
      const c = {
        ...candidate(),
        score: 0,
        budgetCompliant: true,
        actualTier: "p10" as const,
        isFallbackOfLastResort: false,
        scaleFactor: 1,
        isApproximate: true,
        approximationNotes: [],
      };
      expect(matchLabelFor("p10", c, target)).toContain("Approximate");
    });

    it("includes the approximation notes in the label when present", () => {
      const c = {
        ...candidate(),
        score: 0,
        budgetCompliant: true,
        actualTier: "p20" as const,
        isFallbackOfLastResort: false,
        scaleFactor: 1,
        isApproximate: true,
        approximationNotes: ["capped tofu at a realistic 280g instead"],
      };
      expect(matchLabelFor("p20", c, target)).toContain("capped tofu at a realistic 280g instead");
    });

    it("is never set for a normal candidate -- undefined is treated the same as false", () => {
      const c = { ...candidate(), score: 0, budgetCompliant: true, actualTier: "p10" as const, isFallbackOfLastResort: false, scaleFactor: 1 };
      expect(matchLabelFor("p10", c, target)).toBeNull();
    });
  });
});
