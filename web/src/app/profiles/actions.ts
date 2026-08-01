"use server";

import { randomUUID } from "node:crypto";
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
    .select("id, persona_user_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchError || !persona) {
    return { error: fetchError?.message ?? "Persona not found." };
  }

  // Mint a fresh session on demand instead of reusing/refreshing a stored
  // refresh token. Refresh tokens rotate on every use (Supabase default),
  // including transparent refreshes triggered by ordinary page loads
  // elsewhere in the app while acting as this persona -- so a token
  // snapshotted at switch-time inevitably goes stale the moment the
  // persona is used for anything, and the next switch attempt fails with
  // "Invalid Refresh Token: Already Used". A password reset immediately
  // followed by sign-in has no such staleness: it always succeeds
  // regardless of what happened to any previous session, since it doesn't
  // depend on the state of one.
  const email = `persona-${persona.persona_user_id}@personas.macromap.internal`;
  const password = randomUUID();

  const { error: updateAuthError } = await admin.auth.admin.updateUserById(
    persona.persona_user_id,
    { email, password, email_confirm: true },
  );

  if (updateAuthError) {
    return { error: updateAuthError.message };
  }

  const supabase = await createClient();
  const { data, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !data.session) {
    return {
      error: signInError?.message ?? "Failed to switch to this persona.",
    };
  }

  const { error: updateRowError } = await admin
    .from("test_personas")
    .update({
      refresh_token: data.session.refresh_token,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateRowError) {
    return { error: updateRowError.message };
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
