import { describe, it, expect } from "vitest";
import { createRetryBudget, trySpend } from "./retryBudget";

describe("retryBudget", () => {
  it("starts with the given total", () => {
    expect(createRetryBudget(3).remaining).toBe(3);
    expect(createRetryBudget().remaining).toBe(3);
  });

  it("spends tokens one at a time", () => {
    const budget = createRetryBudget(3);
    expect(trySpend(budget)).toBe(true);
    expect(budget.remaining).toBe(2);
  });

  it("refuses to spend more than remains, with no partial spend", () => {
    const budget = createRetryBudget(2);
    expect(trySpend(budget, 3)).toBe(false);
    expect(budget.remaining).toBe(2); // untouched
  });

  it("allows spending exactly the remaining amount", () => {
    const budget = createRetryBudget(3);
    expect(trySpend(budget, 3)).toBe(true);
    expect(budget.remaining).toBe(0);
    expect(trySpend(budget, 1)).toBe(false);
  });
});
