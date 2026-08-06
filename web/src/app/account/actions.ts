"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/identity";
import { deleteAuth0User } from "@/lib/auth0Management";

// Auth0's public Authentication API (no Management API token needed) --
// emails the user a reset link for their Username-Password-Authentication
// connection. MacroMap never sees or handles the password itself either way.
export async function requestPasswordReset(): Promise<{ error: string | null }> {
  const user = await getCurrentUser();
  if (!user?.email) {
    return { error: "No active session — refresh the page and try again." };
  }

  const res = await fetch(`https://${process.env.AUTH0_DOMAIN}/dbconnections/change_password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.AUTH0_CLIENT_ID,
      email: user.email,
      connection: "Username-Password-Authentication",
    }),
  });

  if (!res.ok) {
    return { error: `Failed to send a reset email (${res.status}).` };
  }
  return { error: null };
}

// No more auth.users FK cascade (migration 0034) -- deletes app data
// directly, via the RLS-enforced client so this can never touch another
// user's rows. Deliberately deletes app data BEFORE the Auth0 identity: if
// the Auth0 call fails, the user still has a working login and this action
// is safely retryable (an already-deleted row is just a no-op delete); the
// reverse order would leave a locked-out user with orphaned data only an
// operator could clean up.
export async function deleteAccount(): Promise<{ error: string | null }> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: "No active session — refresh the page and try again." };
  }

  const supabase = await createClient();

  const { error: overridesError } = await supabase
    .from("grocery_price_overrides")
    .delete()
    .eq("user_id", user.id);
  if (overridesError) return { error: overridesError.message };

  const { error: pantryError } = await supabase.from("pantry_items").delete().eq("user_id", user.id);
  if (pantryError) return { error: pantryError.message };

  // meal_plan_slots/meal_plan_slot_addons cascade off this via their
  // existing uuid FKs -- no separate delete needed for either.
  const { error: plansError } = await supabase.from("meal_plans").delete().eq("user_id", user.id);
  if (plansError) return { error: plansError.message };

  const { error: profileError } = await supabase.from("profiles").delete().eq("id", user.id);
  if (profileError) return { error: profileError.message };

  try {
    await deleteAuth0User(user.id);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to delete your account." };
  }

  // Not redirect("/"): the encrypted session cookie stays locally "valid"
  // (decrypted/trusted without a live Auth0 check) even after the
  // underlying Auth0 user is gone -- found live during testing, where a
  // plain "/" redirect left the browser looking logged in with no profile,
  // silently bounced to /onboarding by that page's own logic instead of
  // ending the session. /auth/logout is the SDK's own mounted route; it
  // actually clears the cookie before sending the browser on.
  redirect("/auth/logout");
}
