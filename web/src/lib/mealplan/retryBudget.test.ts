import { describe, it, expect } from "vitest";
import {
  createRetryBudget,
  createSelectionAddonBudget,
  trySpend,
  RECIPE_ACTION_COST,
  ADDON_ATTEMPT_COST,
} from "./retryBudget";

describe("retryBudget", () => {
  it("starts with the given total", () => {
    expect(createRetryBudget(3).remaining).toBe(3);
    // Default = 3 recipe-requeries' worth of quota (preserves the original
    // flat-3 ceiling in points), not 3 flat actions.
    expect(createRetryBudget().remaining).toBe(RECIPE_ACTION_COST * 3);
  });

  it("gives add-on attempts 3x the headroom of recipe actions for the default budget", () => {
    const budget = createRetryBudget();
    let addonAttempts = 0;
    while (trySpend(budget, ADDON_ATTEMPT_COST)) addonAttempts++;
    expect(addonAttempts).toBe(9);

    const recipeBudget = createRetryBudget();
    let recipeAttempts = 0;
    while (trySpend(recipeBudget, RECIPE_ACTION_COST)) recipeAttempts++;
    expect(recipeAttempts).toBe(3);
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

describe("createSelectionAddonBudget", () => {
  it("covers one addon attempt for every recipe slot in a week (3 meals x 7 days = 21)", () => {
    const budget = createSelectionAddonBudget();
    expect(budget.remaining).toBe(21);
    let attempts = 0;
    while (trySpend(budget, ADDON_ATTEMPT_COST)) attempts++;
    expect(attempts).toBe(21);
  });
});
