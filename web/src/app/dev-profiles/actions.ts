"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireGateCookie } from "./gate";

export async function createPersona(
  label: string,
): Promise<{ error: string | null }> {
  await requireGateCookie();

  const trimmed = label.trim();
  if (!trimmed) {
    return { error: "Label is required." };
  }

  const supabase = await createClient();
  const { data, error: signInError } = await supabase.auth.signInAnonymously();

  if (signInError || !data.session || !data.user) {
    return {
      error: signInError?.message ?? "Failed to create a new identity.",
    };
  }

  const admin = createAdminClient();
  const { error: insertError } = await admin.from("test_personas").insert({
    label: trimmed,
    persona_user_id: data.user.id,
    refresh_token: data.session.refresh_token,
  });

  if (insertError) {
    return { error: insertError.message };
  }

  return { error: null };
}

export async function switchPersona(
  id: string,
): Promise<{ error: string | null }> {
  await requireGateCookie();

  const admin = createAdminClient();
  const { data: persona, error: fetchError } = await admin
    .from("test_personas")
    .select("id, refresh_token")
    .eq("id", id)
    .maybeSingle();

  if (fetchError || !persona) {
    return { error: fetchError?.message ?? "Persona not found." };
  }

  const supabase = await createClient();
  const { data, error: refreshError } = await supabase.auth.refreshSession({
    refresh_token: persona.refresh_token,
  });

  if (refreshError || !data.session) {
    return {
      error:
        refreshError?.message ??
        "Failed to switch — the saved refresh token may be expired or already used. Delete and recreate this persona.",
    };
  }

  // Refresh tokens rotate on every use (Supabase default) — the new one
  // MUST be re-persisted, or the next switch to this persona will fail.
  const { error: updateError } = await admin
    .from("test_personas")
    .update({
      refresh_token: data.session.refresh_token,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateError) {
    return { error: updateError.message };
  }

  return { error: null };
}

export async function deletePersona(
  id: string,
): Promise<{ error: string | null }> {
  await requireGateCookie();

  const admin = createAdminClient();
  const { data: persona, error: fetchError } = await admin
    .from("test_personas")
    .select("id, persona_user_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchError || !persona) {
    return { error: fetchError?.message ?? "Persona not found." };
  }

  // Deletes the auth.users row; on-delete-cascade FKs (profiles, meal_plans,
  // pantry_items, grocery_price_overrides) clean up everything else.
  const { error: deleteUserError } = await admin.auth.admin.deleteUser(
    persona.persona_user_id,
  );

  if (deleteUserError) {
    return { error: deleteUserError.message };
  }

  const { error: deleteRowError } = await admin
    .from("test_personas")
    .delete()
    .eq("id", id);

  if (deleteRowError) {
    return { error: deleteRowError.message };
  }

  return { error: null };
}
