import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

// Shared by the login page/action and the dashboard page/actions. Two
// independent checks, not one: TEST_LOGIN_PASSPHRASE being unset (never the
// case in the deployed production container) 404s the whole route tree
// regardless of any cookie state, so this tool can't come back to life just
// because a stale gate cookie survived from local testing.
export const GATE_COOKIE = "test_profiles_gate";

export function requireTestProfilesEnabled() {
  if (!process.env.TEST_LOGIN_PASSPHRASE) {
    notFound();
  }
}

export async function requireGateCookie() {
  requireTestProfilesEnabled();

  const cookieStore = await cookies();
  const value = cookieStore.get(GATE_COOKIE)?.value;

  if (value !== process.env.TEST_LOGIN_PASSPHRASE) {
    redirect("/dev-profiles/login");
  }
}
