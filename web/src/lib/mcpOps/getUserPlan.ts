import { createAdminClient } from "@/lib/supabase/admin";

// Takes the Auth0 subject id directly (profiles.id / meal_plans.user_id,
// migration 0034) -- there's no more label->id indirection now that
// test_personas is gone. Grab the id from the Auth0 dashboard's Users list.
export async function getUserPlan(userId: string) {
  const admin = createAdminClient();

  const { data: plan, error: planError } = await admin
    .from("meal_plans")
    .select(
      "id, weekly_target_calories, weekly_target_protein_g, weekly_target_carbs_g, weekly_target_fat_g, weekly_actual_calories, weekly_actual_protein_g, weekly_actual_carbs_g, weekly_actual_fat_g, reconciliation_status, generated_at",
    )
    .eq("user_id", userId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (planError) throw new Error(`plan lookup failed: ${planError.message}`);
  if (!plan) return { userId, plan: null, slots: [] };

  const { data: slots, error: slotsError } = await admin
    .from("meal_plan_slots")
    .select("day_index, meal_type, recipe_title, calories, protein_g, carbs_g, fat_g, match_label")
    .eq("meal_plan_id", plan.id)
    .order("day_index", { ascending: true });
  if (slotsError) throw new Error(`slots lookup failed: ${slotsError.message}`);

  return { userId, plan, slots: slots ?? [] };
}
