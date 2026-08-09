import { describe, it, expect } from "vitest";
import { resolveDayReference } from "./resolveDayReference";

// Wednesday, 2026-08-12 -- getDay() === 3.
const WEDNESDAY = new Date(2026, 7, 12);

describe("resolveDayReference", () => {
  it("resolves 'today' to dayIndex 0", () => {
    expect(resolveDayReference("swap today's lunch", WEDNESDAY)).toEqual({ dayIndex: 0, matchedPhrase: "today" });
  });

  it("resolves 'tonight' to dayIndex 0", () => {
    expect(resolveDayReference("what's in tonight's dinner", WEDNESDAY)).toEqual({
      dayIndex: 0,
      matchedPhrase: "tonight",
    });
  });

  it("resolves 'tomorrow' to dayIndex 1", () => {
    expect(resolveDayReference("swap tomorrow's breakfast", WEDNESDAY)).toEqual({
      dayIndex: 1,
      matchedPhrase: "tomorrow",
    });
  });

  it("resolves a weekday matching today's own weekday to dayIndex 0, not 7", () => {
    expect(resolveDayReference("swap Wednesday's dinner", WEDNESDAY)).toEqual({
      dayIndex: 0,
      matchedPhrase: "wednesday",
    });
  });

  it("resolves a future weekday to the correct offset within the rolling week", () => {
    // Wednesday + 2 = Friday
    expect(resolveDayReference("swap Friday's lunch", WEDNESDAY)).toEqual({ dayIndex: 2, matchedPhrase: "friday" });
  });

  it("resolves a weekday earlier in Date.getDay() order by wrapping forward", () => {
    // Wednesday(3) -> Monday(1): (1 - 3 + 7) % 7 = 5
    expect(resolveDayReference("swap Monday's dinner", WEDNESDAY)).toEqual({ dayIndex: 5, matchedPhrase: "monday" });
  });

  it("is case-insensitive", () => {
    expect(resolveDayReference("swap FRIDAY's lunch", WEDNESDAY)).toEqual({ dayIndex: 2, matchedPhrase: "friday" });
  });

  it("is word-boundary safe (does not false-match inside another word)", () => {
    expect(resolveDayReference("I need a Mondayish vibe today's meals", WEDNESDAY)).toEqual({
      dayIndex: 0,
      matchedPhrase: "today",
    });
    expect(resolveDayReference("Mondayish plans please", WEDNESDAY)).toBeNull();
  });

  it("returns null for 'next <today's weekday>' -- ambiguous, falls outside the 0-6 window", () => {
    expect(resolveDayReference("swap next Wednesday's dinner", WEDNESDAY)).toBeNull();
  });

  it("does not treat 'next <other weekday>' as ambiguous", () => {
    expect(resolveDayReference("swap next Friday's dinner", WEDNESDAY)).toEqual({
      dayIndex: 2,
      matchedPhrase: "friday",
    });
  });

  it("returns null when no day reference is present", () => {
    expect(resolveDayReference("what's in my pantry", WEDNESDAY)).toBeNull();
  });
});
