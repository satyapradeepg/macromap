import { describe, it, expect } from "vitest";
import {
  createRetryBudget,
  createSelectionAddonBudget,
  createAiComposeBudget,
  createBadFitSwapBudget,
  trySpend,
  RECIPE_ACTION_COST,
  ADDON_ATTEMPT_COST,
  AI_COMPOSE_ACTION_COST,
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

// Found live 2026-07-21: sharing createAiComposeBudget between the
// genuinely-blocked pass and the newer bad-fit-but-claimed pass let a
// profile with many blocked slots exhaust the whole thing before the
// bad-fit pass ever got a chance -- observed 3 live runs in a row, same 2
// slots starved every time. This is a separate, additive budget so that
// pass always gets a real chance regardless of how many slots are
// blocked that week.
describe("createBadFitSwapBudget", () => {
  it("is a separate budget from createAiComposeBudget, not shared or carved out of it", () => {
    const aiComposeBudget = createAiComposeBudget();
    const badFitBudget = createBadFitSwapBudget();
    // Draining the blocked-slot budget entirely must not affect the
    // bad-fit budget at all -- they're independent objects.
    while (trySpend(aiComposeBudget, AI_COMPOSE_ACTION_COST)) {
      /* drain */
    }
    expect(aiComposeBudget.remaining).toBe(0);
    expect(badFitBudget.remaining).toBe(AI_COMPOSE_ACTION_COST * 2);
  });

  it("guarantees at least 2 attempts, matching the typical 1-3 thin-pool slots per plan found in the offline cached-pool survey", () => {
    const budget = createBadFitSwapBudget();
    let attempts = 0;
    while (trySpend(budget, AI_COMPOSE_ACTION_COST)) attempts++;
    expect(attempts).toBe(2);
  });
});
