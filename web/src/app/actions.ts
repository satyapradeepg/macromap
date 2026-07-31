"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { GATE_COOKIE } from "./profiles/gate";

// Only clears the /profiles login gate — the underlying anonymous Supabase
// session is left alone, since middleware.ts re-mints one transparently on
// the next request regardless. Logging out just means "ask for the
// username+password again before reaching /profiles."
export async function logout() {
  const cookieStore = await cookies();
  // The gate cookie was set with path: "/profiles" (login/actions.ts) — a
  // delete/set call must match that exact path, or the browser keeps the
  // original cookie around untouched (cookie deletion is matched by
  // name+path+domain, not name alone).
  cookieStore.set(GATE_COOKIE, "", { path: "/profiles", maxAge: 0 });
  redirect("/");
}
