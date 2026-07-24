import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recomputeWeeklyActual } from "./actions";

interface SlotRow {
  id: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

interface AddonRow {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

// Minimal fake of the chained Supabase query builder — only implements the
// exact chains recomputeWeeklyActual calls (from/select/eq, from/select/in,
// from/update/eq), not a general-purpose mock. Records every update payload
// per table so tests can assert what got persisted, not just the return value.
function fakeSupabase(slots: SlotRow[], addons: AddonRow[]) {
  const updatesByTable = new Map<string, Record<string, unknown>[]>();
  const addonsQueried: unknown[][] = [];

  const from = (table: string) => ({
    select: () => ({
      eq: () => {
        if (table !== "meal_plan_slots") throw new Error(`unexpected select().eq() on ${table}`);
        return Promise.resolve({ data: slots });
      },
      in: (_col: string, slotIds: unknown[]) => {
        if (table !== "meal_plan_slot_addons") throw new Error(`unexpected select().in() on ${table}`);
        addonsQueried.push(slotIds);
        return Promise.resolve({ data: addons });
      },
    }),
    update: (payload: Record<string, unknown>) => ({
      eq: () => {
        const existing = updatesByTable.get(table) ?? [];
        existing.push(payload);
        updatesByTable.set(table, existing);
        return Promise.resolve({ data: null, error: null });
      },
    }),
  });

  return { supabase: { from } as unknown as SupabaseClient, updatesByTable, addonsQueried };
}

describe("recomputeWeeklyActual", () => {
  it("sums slot macros and persists the total to meal_plans", async () => {
    const slots: SlotRow[] = [
      { id: "s1", calories: 400, protein_g: 30, carbs_g: 40, fat_g: 10 },
      { id: "s2", calories: 600, protein_g: 40, carbs_g: 60, fat_g: 20 },
    ];
    const { supabase, updatesByTable } = fakeSupabase(slots, []);

    const result = await recomputeWeeklyActual(supabase, "plan-1");

    expect(result).toEqual({ calories: 1000, proteinG: 70, carbsG: 100, fatG: 30 });
    expect(updatesByTable.get("meal_plans")).toEqual([
      {
        weekly_actual_calories: 1000,
        weekly_actual_protein_g: 70,
        weekly_actual_carbs_g: 100,
        weekly_actual_fat_g: 30,
      },
    ]);
  });

  it("adds add-on macros on top of slot macros", async () => {
    const slots: SlotRow[] = [{ id: "s1", calories: 400, protein_g: 30, carbs_g: 40, fat_g: 10 }];
    const addons: AddonRow[] = [{ calories: 60, protein_g: 5, carbs_g: 6, fat_g: 2 }];
    const { supabase, addonsQueried } = fakeSupabase(slots, addons);

    const result = await recomputeWeeklyActual(supabase, "plan-1");

    expect(result).toEqual({ calories: 460, proteinG: 35, carbsG: 46, fatG: 12 });
    expect(addonsQueried).toEqual([["s1"]]);
  });

  it("returns all-zero totals and skips querying add-ons when the plan has no slots", async () => {
    const { supabase, addonsQueried } = fakeSupabase([], []);

    const result = await recomputeWeeklyActual(supabase, "plan-1");

    expect(result).toEqual({ calories: 0, proteinG: 0, carbsG: 0, fatG: 0 });
    expect(addonsQueried).toEqual([]);
  });
});
