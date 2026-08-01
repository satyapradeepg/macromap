"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Ends the current persona's Supabase session and returns to the profile
// picker. There's no separate site-wide login to sign out of anymore --
// HTTP Basic Auth (middleware.ts) handles that, and the browser holds
// those credentials itself, outside the app's control. This button's job
// is narrower: "stop being this persona."
export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/profiles");
}
