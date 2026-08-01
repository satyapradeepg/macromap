import { createAdminClient } from "@/lib/supabase/admin";

export async function getPersonaPlan(label: string) {
  const admin = createAdminClient();

  const { data: persona, error: personaError } = await admin
    .from("test_personas")
    .select("persona_user_id")
    .eq("label", label)
    .maybeSingle();
  if (personaError) throw new Error(`persona lookup failed: ${personaError.message}`);
  if (!persona) throw new Error(`no test persona with label "${label}"`);

  const { data: plan, error: planError } = await admin
    .from("meal_plans")
    .select(
      "id, weekly_target_calories, weekly_target_protein_g, weekly_target_carbs_g, weekly_target_fat_g, weekly_actual_calories, weekly_actual_protein_g, weekly_actual_carbs_g, weekly_actual_fat_g, reconciliation_status, generated_at",
    )
    .eq("user_id", persona.persona_user_id)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (planError) throw new Error(`plan lookup failed: ${planError.message}`);
  if (!plan) return { persona: label, plan: null, slots: [] };

  const { data: slots, error: slotsError } = await admin
    .from("meal_plan_slots")
    .select("day_index, meal_type, recipe_title, calories, protein_g, carbs_g, fat_g, match_label")
    .eq("meal_plan_id", plan.id)
    .order("day_index", { ascending: true });
  if (slotsError) throw new Error(`slots lookup failed: ${slotsError.message}`);

  return { persona: label, plan, slots: slots ?? [] };
}
