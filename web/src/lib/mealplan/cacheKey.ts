// Epic E2 (F3) — cross-user recipe_query_cache key (ai-agents.md Agent 2).
// Keyed on the *shared* constraint tuple, including the actual macro
// bounds — Spoonacular's own minProtein/maxProtein/minCalories/maxCalories
// filter IS the right retrieval mechanism (OQ2), verified directly against
// the live API: an unfiltered fetch of only the first N results out of a
// multi-thousand-recipe corpus is closer to a random sample than a
// targeted one, which starves variety far more than the filter itself ever
// did. excludeIds is deliberately excluded (per-user, would fragment the
// cache to a near-zero hit rate). Runs server-side only (Server Actions),
// so Node's built-in crypto is available — no extra dependency.

import { createHash } from "node:crypto";

export interface QuerySignature {
  minProtein: number;
  maxProtein: number;
  minCalories: number;
  maxCalories: number;
  diet: string | undefined;
  // Was missing from the hash entirely despite affecting the real query —
  // two profiles with different intolerances but the same diet/exclusions
  // would have silently shared a cache entry. Fixed here.
  intolerances: string[];
  excludeIngredients: string[];
  // How many candidates were requested per query. Included so that tuning
  // this constant (e.g. after the "only 2 of 21 meals" pool-size bug) can't
  // silently keep serving smaller stale pools from cache under the old key
  // shape — bumping it naturally misses the old cache rows instead of
  // requiring a manual truncate every time this knob changes.
  resultCount: number;
}

export function recipeCacheKey(sig: QuerySignature): string {
  const canonical = {
    minProtein: roundForKey(sig.minProtein),
    maxProtein: roundForKey(sig.maxProtein),
    minCalories: roundForKey(sig.minCalories),
    maxCalories: roundForKey(sig.maxCalories),
    diet: sig.diet ?? null,
    intolerances: [...sig.intolerances].map((s) => s.toLowerCase()).sort(),
    excludeIngredients: [...sig.excludeIngredients].map((s) => s.toLowerCase()).sort(),
    resultCount: sig.resultCount,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// Bounds are floating-point (target * (1 +/- pct)) — round before hashing so
// near-identical targets (e.g. 100.0000001 vs 100.0) don't fragment the key.
function roundForKey(n: number): number {
  return Math.round(n * 100) / 100;
}

export const CACHE_STALENESS_DAYS = 7;

export function isStale(fetchedAt: Date, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - fetchedAt.getTime();
  return ageMs > CACHE_STALENESS_DAYS * 24 * 60 * 60 * 1000;
}
