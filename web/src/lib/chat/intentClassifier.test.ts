import { describe, it, expect } from "vitest";
import { validateIntentClassification, buildIntentClassificationPrompt } from "./intentClassifier";

describe("validateIntentClassification", () => {
  it("accepts a well-formed swap_meal intent", () => {
    const result = validateIntentClassification({
      intents: [{ intent: "swap_meal", dayIndex: 2, mealType: "dinner" }],
    });
    expect(result).toEqual([{ kind: "swap_meal", dayIndex: 2, mealType: "dinner" }]);
  });

  it("rejects swap_meal missing dayIndex", () => {
    expect(validateIntentClassification({ intents: [{ intent: "swap_meal", mealType: "dinner" }] })).toBeNull();
  });

  it("rejects swap_meal with an out-of-range dayIndex", () => {
    expect(validateIntentClassification({ intents: [{ intent: "swap_meal", dayIndex: 7, mealType: "dinner" }] })).toBeNull();
  });

  it("rejects swap_meal with an invalid mealType", () => {
    expect(validateIntentClassification({ intents: [{ intent: "swap_meal", dayIndex: 0, mealType: "brunch" }] })).toBeNull();
  });

  it("accepts a well-formed edit_pantry intent with multiple operations", () => {
    const result = validateIntentClassification({
      intents: [
        {
          intent: "edit_pantry",
          pantryOperations: [
            { action: "add", itemName: "chicken breast", quantityText: "2 lbs" },
            { action: "remove", itemName: "eggs" },
          ],
        },
      ],
    });
    expect(result).toEqual([
      {
        kind: "edit_pantry",
        operations: [
          { action: "add", itemName: "chicken breast", quantityText: "2 lbs" },
          { action: "remove", itemName: "eggs", quantityText: null },
        ],
      },
    ]);
  });

  it("rejects edit_pantry with empty operations", () => {
    expect(validateIntentClassification({ intents: [{ intent: "edit_pantry", pantryOperations: [] }] })).toBeNull();
  });

  it("rejects edit_pantry op missing itemName", () => {
    expect(
      validateIntentClassification({ intents: [{ intent: "edit_pantry", pantryOperations: [{ action: "add" }] }] }),
    ).toBeNull();
  });

  it("accepts edit_profile with an add/remove list field and a set field", () => {
    const result = validateIntentClassification({
      intents: [
        {
          intent: "edit_profile",
          profileOperations: [
            { field: "allergies", action: "add", value: "peanuts" },
            { field: "goal", action: "set", value: "bulk" },
          ],
        },
      ],
    });
    expect(result).toEqual([
      {
        kind: "edit_profile",
        operations: [
          { field: "allergies", action: "add", value: "peanuts" },
          { field: "goal", action: "set", value: "bulk" },
        ],
      },
    ]);
  });

  it("rejects edit_profile using 'set' on a list field", () => {
    expect(
      validateIntentClassification({
        intents: [{ intent: "edit_profile", profileOperations: [{ field: "allergies", action: "set", value: "peanuts" }] }],
      }),
    ).toBeNull();
  });

  it("rejects edit_profile using 'add' on a set-only field", () => {
    expect(
      validateIntentClassification({
        intents: [{ intent: "edit_profile", profileOperations: [{ field: "goal", action: "add", value: "bulk" }] }],
      }),
    ).toBeNull();
  });

  it("rejects edit_profile with an unknown field", () => {
    expect(
      validateIntentClassification({
        intents: [{ intent: "edit_profile", profileOperations: [{ field: "budget", action: "set", value: "100" }] }],
      }),
    ).toBeNull();
  });

  it("accepts read_only_qa with a topic and optional day/meal", () => {
    const result = validateIntentClassification({
      intents: [{ intent: "read_only_qa", qaTopic: "specific_meal_details", dayIndex: 0, mealType: "dinner" }],
    });
    expect(result).toEqual([{ kind: "read_only_qa", qaTopic: "specific_meal_details", dayIndex: 0, mealType: "dinner" }]);
  });

  it("accepts read_only_qa with no day/meal (defaults to null)", () => {
    const result = validateIntentClassification({
      intents: [{ intent: "read_only_qa", qaTopic: "remaining_weekly_macros" }],
    });
    expect(result).toEqual([{ kind: "read_only_qa", qaTopic: "remaining_weekly_macros", dayIndex: null, mealType: null }]);
  });

  it("rejects read_only_qa with an invalid qaTopic", () => {
    expect(validateIntentClassification({ intents: [{ intent: "read_only_qa", qaTopic: "budget" }] })).toBeNull();
  });

  it("accepts a well-formed edit_meal_recipe intent", () => {
    const result = validateIntentClassification({
      intents: [{ intent: "edit_meal_recipe", dayIndex: 0, mealType: "dinner", editInstruction: "remove the onions" }],
    });
    expect(result).toEqual([{ kind: "edit_meal_recipe", dayIndex: 0, mealType: "dinner", editInstruction: "remove the onions" }]);
  });

  it("rejects edit_meal_recipe missing editInstruction", () => {
    expect(validateIntentClassification({ intents: [{ intent: "edit_meal_recipe", dayIndex: 0, mealType: "dinner" }] })).toBeNull();
  });

  it("rejects edit_meal_recipe with an empty editInstruction", () => {
    expect(
      validateIntentClassification({ intents: [{ intent: "edit_meal_recipe", dayIndex: 0, mealType: "dinner", editInstruction: "  " }] }),
    ).toBeNull();
  });

  it("rejects edit_meal_recipe missing dayIndex/mealType", () => {
    expect(validateIntentClassification({ intents: [{ intent: "edit_meal_recipe", editInstruction: "remove onions" }] })).toBeNull();
  });

  it("accepts confirm_pending_action with a boolean confirmed field", () => {
    expect(validateIntentClassification({ intents: [{ intent: "confirm_pending_action", confirmed: true }] })).toEqual([
      { kind: "confirm_pending_action", confirmed: true },
    ]);
    expect(validateIntentClassification({ intents: [{ intent: "confirm_pending_action", confirmed: false }] })).toEqual([
      { kind: "confirm_pending_action", confirmed: false },
    ]);
  });

  it("rejects confirm_pending_action with a non-boolean confirmed field", () => {
    expect(validateIntentClassification({ intents: [{ intent: "confirm_pending_action", confirmed: "yes" }] })).toBeNull();
  });

  it("accepts clarify and refuse with a message", () => {
    expect(validateIntentClassification({ intents: [{ intent: "clarify", message: "Which day did you mean?" }] })).toEqual([
      { kind: "clarify", message: "Which day did you mean?" },
    ]);
    expect(validateIntentClassification({ intents: [{ intent: "refuse", message: "I can't change the budget here." }] })).toEqual([
      { kind: "refuse", message: "I can't change the budget here." },
    ]);
  });

  it("rejects clarify/refuse with an empty message", () => {
    expect(validateIntentClassification({ intents: [{ intent: "clarify", message: "" }] })).toBeNull();
  });

  it("rejects an unknown intent kind", () => {
    expect(validateIntentClassification({ intents: [{ intent: "delete_account" }] })).toBeNull();
  });

  it("rejects the whole batch if any single intent is malformed", () => {
    expect(
      validateIntentClassification({
        intents: [{ intent: "swap_meal", dayIndex: 0, mealType: "dinner" }, { intent: "swap_meal" }],
      }),
    ).toBeNull();
  });

  it("accepts a compound message resolving to multiple intents", () => {
    const result = validateIntentClassification({
      intents: [
        { intent: "edit_pantry", pantryOperations: [{ action: "remove", itemName: "onions" }] },
        { intent: "swap_meal", dayIndex: 1, mealType: "lunch" },
      ],
    });
    expect(result).toHaveLength(2);
  });

  it("rejects a non-array intents field, missing intents, and non-object input", () => {
    expect(validateIntentClassification({ intents: [] })).toBeNull();
    expect(validateIntentClassification({})).toBeNull();
    expect(validateIntentClassification(null)).toBeNull();
    expect(validateIntentClassification("swap dinner")).toBeNull();
  });
});

describe("buildIntentClassificationPrompt", () => {
  it("includes the resolved day hint when present", () => {
    const prompt = buildIntentClassificationPrompt({
      message: "swap tomorrow's dinner",
      resolvedDayIndex: 1,
      resolvedMatchedPhrase: "tomorrow",
      todayWeekdayName: "Wednesday",
      pendingSuggestion: null,
    });
    expect(prompt).toContain("tomorrow");
    expect(prompt).toContain("dayIndex 1");
  });

  it("tells the model to clarify rather than guess when no day was resolved", () => {
    const prompt = buildIntentClassificationPrompt({
      message: "swap my dinner",
      resolvedDayIndex: null,
      resolvedMatchedPhrase: null,
      todayWeekdayName: "Wednesday",
      pendingSuggestion: null,
    });
    expect(prompt).toContain("No day reference was deterministically resolved");
  });

  it("includes the verbatim user message", () => {
    const prompt = buildIntentClassificationPrompt({
      message: "I'm allergic to peanuts now",
      resolvedDayIndex: null,
      resolvedMatchedPhrase: null,
      todayWeekdayName: "Monday",
      pendingSuggestion: null,
    });
    expect(prompt).toContain("I'm allergic to peanuts now");
  });

  it("includes the pending suggestion context when one is present", () => {
    const prompt = buildIntentClassificationPrompt({
      message: "yeah go for it",
      resolvedDayIndex: null,
      resolvedMatchedPhrase: null,
      todayWeekdayName: "Monday",
      pendingSuggestion: "use 280g of chicken instead, for Dinner on day 1",
    });
    expect(prompt).toContain("use 280g of chicken instead, for Dinner on day 1");
    expect(prompt).toContain("confirm_pending_action");
  });

  it("omits the pending suggestion paragraph when there is none", () => {
    const prompt = buildIntentClassificationPrompt({
      message: "swap tomorrow's dinner",
      resolvedDayIndex: 1,
      resolvedMatchedPhrase: "tomorrow",
      todayWeekdayName: "Wednesday",
      pendingSuggestion: null,
    });
    expect(prompt).not.toContain("hasn't confirmed or declined yet");
  });
});
