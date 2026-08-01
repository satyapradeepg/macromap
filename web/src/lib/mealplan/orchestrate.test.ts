import { describe, it, expect } from "vitest";
import { toDisclosedNote, MAX_DISCLOSED_NOTE_LENGTH } from "./orchestrate";

// Live-confirmed 2026-08-01: the plan critic (planCritic.ts) is prompted
// for "one sentence" but that isn't enforced by the API -- a real critique
// response returned a rambling, self-contradictory note that read like the
// model's own internal deliberation rather than a verdict, and it reached
// the unresolvedDietaryConcerns disclosure banner verbatim. toDisclosedNote
// is the defensive backstop: independent of whatever the prompt asks for.
describe("toDisclosedNote", () => {
  it("passes through a short, plausible one-sentence note unchanged", () => {
    const note = "Contains dairy (parmesan), which conflicts with your vegan diet.";
    expect(toDisclosedNote(note)).toBe(note);
  });

  it("trims surrounding whitespace on an otherwise-short note", () => {
    expect(toDisclosedNote("  Contains soy sauce.  ")).toBe("Contains soy sauce.");
  });

  // The actual live-observed failure: a rambling note that second-guesses
  // its own diet_violation classification mid-sentence.
  it("replaces an overlong, rambling note with a clean fallback message", () => {
    const ramblingNote =
      'Mon lunch: Seitan Stir-Fry with Rice and Peanut Sauce uses peanut oil/sauce paired with seitan ' +
      '(vital wheat gluten, plant-based, fine) but check: peanut oil itself isn\'t soy so ok, but the dish ' +
      'is likely fine - actually flagging for repetition of seitan+rice pattern, not diet violation.';
    expect(ramblingNote.length).toBeGreaterThan(MAX_DISCLOSED_NOTE_LENGTH);
    expect(toDisclosedNote(ramblingNote)).toBe(
      "This meal may not fully match your dietary restrictions -- please check its ingredients before eating it.",
    );
  });

  it("replaces an empty or whitespace-only note with the fallback rather than showing nothing", () => {
    expect(toDisclosedNote("")).not.toBe("");
    expect(toDisclosedNote("   ")).not.toBe("");
  });

  it("accepts a note exactly at the length boundary, replaces one character over it", () => {
    const atBoundary = "a".repeat(MAX_DISCLOSED_NOTE_LENGTH);
    const overBoundary = "a".repeat(MAX_DISCLOSED_NOTE_LENGTH + 1);
    expect(toDisclosedNote(atBoundary)).toBe(atBoundary);
    expect(toDisclosedNote(overBoundary)).not.toBe(overBoundary);
  });
});
