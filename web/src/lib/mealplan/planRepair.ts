// Post-generation plan critique + repair (built July 15 2026, following
// Satya's idea after the engine audit surfaced real variety problems the
// per-slot pipeline structurally can't see on its own).
//
// Split of responsibility, same grounding rule as the rest of this
// pipeline: an LLM critic (planCritic.ts) gets the WHOLE week at once --
// something no per-slot deterministic step ever sees -- and flags which
// specific slots look repetitive or off-target. That's a genuine judgment
// call (spotting a pattern across 35 slots), not arithmetic. What this
// file does is the arithmetic: given a flagged slot, an alternative
// candidate from the existing swap mechanism, and the real macro numbers
// for both, decide -- deterministically -- whether the alternative is
// actually better. The critic never decides "better," only "worth a
// second look."
//
// "Better" itself is intentionally conservative: a swap is only accepted
// if it strictly improves macro fit AND (for a repetition flag)
// genuinely reduces duplication rather than trading one repeat for
// another. Ties or ambiguous cases keep the original -- never swap for a
// non-improvement, same "never fake progress" discipline as everywhere
// else in this pipeline. The one exception is a genuine diet_violation
// (added July 16 2026): safety overrides macro fit, so that reason skips
// the improvement check entirely -- see shouldAcceptRepair below.

export type RepairReason = "repetitive" | "macro_miss" | "diet_violation" | "other";

export interface RepairCandidateInfo {
  title: string;
  proteinG: number;
  caloriesKcal: number;
  carbsG: number;
  fatG: number;
}

export interface RepairTarget {
  proteinG: number;
  calories: number;
  carbsG: number;
  fatG: number;
}

// A swap must beat the original by more than floating-point noise to
// count as "meaningfully better" -- otherwise a candidate that's
// essentially identical in fit would flicker in and out depending on
// tiny real-data differences, for no real user-facing benefit.
const MIN_SCORE_IMPROVEMENT = 0.01;

export function shouldAcceptRepair(params: {
  reason: RepairReason;
  oldScore: number;
  newScore: number;
  // Titles of every OTHER slot already claimed in the plan (excluding the
  // one being repaired) -- used only for the repetition check.
  otherTitlesInPlan: string[];
  newCandidateTitle: string;
}): boolean {
  const { reason, oldScore, newScore, otherTitlesInPlan, newCandidateTitle } = params;

  // Safety-first exception (added July 16 2026, following the string-
  // matching audit): the caller only ever invokes this with a real,
  // already-safety-filtered replacement candidate in hand (orchestrate.ts
  // bails out to "keep original" before calling this at all when no
  // candidate was found) -- so for a genuine diet violation, that
  // candidate always beats a known violation, even one with a worse
  // macro score than the original. Every other reason still requires a
  // real macro improvement; only safety overrides fit.
  if (reason === "diet_violation") return true;

  const meaningfullyBetter = oldScore - newScore > MIN_SCORE_IMPROVEMENT;
  if (!meaningfullyBetter) return false;

  if (reason === "repetitive") {
    // Swapping one duplicate for a DIFFERENT duplicate doesn't resolve
    // what the critic actually flagged -- only accept if the new pick is
    // genuinely not already used elsewhere in the week.
    const stillDuplicated = otherTitlesInPlan.includes(newCandidateTitle);
    if (stillDuplicated) return false;
  }

  return true;
}
