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

  const cookieStore = await cookies();
  cookieStore.set(GATE_COOKIE, gateValueFor(username, password), {
    httpOnly: true,
    sameSite: "lax",
    path: "/profiles",
  });

  return { error: null };
}
