import { createAdminClient } from "@/lib/supabase/admin";

export async function listTestPersonas() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("test_personas")
    .select("label, persona_user_id, created_at, last_used_at")
    .order("last_used_at", { ascending: false });

  if (error) throw new Error(`list_test_personas failed: ${error.message}`);
  return data ?? [];
}
