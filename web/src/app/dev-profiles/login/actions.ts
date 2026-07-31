"use server";

import { cookies } from "next/headers";
import { GATE_COOKIE, requireTestProfilesEnabled } from "../gate";

export async function checkPassphrase(
  passphrase: string,
): Promise<{ error: string | null }> {
  requireTestProfilesEnabled();

  if (passphrase !== process.env.TEST_LOGIN_PASSPHRASE) {
    return { error: "Incorrect passphrase." };
  }

  const cookieStore = await cookies();
  cookieStore.set(GATE_COOKIE, passphrase, {
    httpOnly: true,
    sameSite: "lax",
    path: "/dev-profiles",
  });

  return { error: null };
}
