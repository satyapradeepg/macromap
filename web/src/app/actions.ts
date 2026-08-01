"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { GATE_COOKIE } from "./profiles/gate";

// Only clears the login gate cookie — logging out just means "ask for the
// username+password again before reaching /profiles, /onboarding, or /plan."
export async function logout() {
  const cookieStore = await cookies();
  // The gate cookie is set with path: "/" (login/actions.ts) — a delete/set
  // call must match that exact path, or the browser keeps the original
  // cookie around untouched (cookie deletion is matched by name+path+domain,
  // not name alone).
  cookieStore.set(GATE_COOKIE, "", { path: "/", maxAge: 0 });
  // Redirecting to "/" (not directly to the login screen) used to bounce
  // the user right back to /plan: the landing page (page.tsx) redirects any
  // visitor with a still-valid Supabase user + completed profile straight
  // to /plan, and clearing the gate cookie here doesn't touch that Supabase
  // session at all -- so logging out silently landed back on the exact
  // page you were leaving, looking like the button did nothing. Redirecting
  // straight to the login screen skips that bounce entirely.
  redirect("/profiles/login");
}
