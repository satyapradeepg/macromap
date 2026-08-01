"use server";

import { cookies } from "next/headers";
import { GATE_COOKIE, gateValueFor, requireTestProfilesEnabled } from "../gate";

export async function checkCredentials(
  username: string,
  password: string,
): Promise<{ error: string | null }> {
  requireTestProfilesEnabled();

  if (
    username !== process.env.ACCESS_USERNAME ||
    password !== process.env.ACCESS_PASSWORD
  ) {
    return { error: "Incorrect username or password." };
  }

  // path must be "/" (not "/profiles"): /onboarding and /plan are gated
  // with this same cookie too, and a browser only sends a cookie on
  // requests whose path matches the cookie's own path as a prefix -- a
  // "/profiles"-scoped cookie is never sent to those sibling routes at
  // all, so requireGateCookie() there would always see no cookie and
  // redirect to login, even for an already-authenticated visitor.
  const cookieStore = await cookies();
  cookieStore.set(GATE_COOKIE, gateValueFor(username, password), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });

  return { error: null };
}
