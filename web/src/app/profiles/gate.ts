import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

// Shared by the login page/action and the dashboard page/actions. Gates
// access with a single shared username+password, set directly on the
// Container App for the duration of a showcase window (not wired into
// deploy.yml's CI secret sync — rotated/removed by Satya via a manual
// `az containerapp update --set-env-vars` call, no redeploy needed). Either
// var being unset 404s the whole route tree regardless of any cookie state.
export const GATE_COOKIE = "access_gate";

export function requireTestProfilesEnabled() {
  if (!process.env.ACCESS_USERNAME || !process.env.ACCESS_PASSWORD) {
    notFound();
  }
}

function expectedGateValue(): string {
  return `${process.env.ACCESS_USERNAME}:${process.env.ACCESS_PASSWORD}`;
}

export function gateValueFor(username: string, password: string): string {
  return `${username}:${password}`;
}

export async function requireGateCookie() {
  requireTestProfilesEnabled();

  const cookieStore = await cookies();
  const value = cookieStore.get(GATE_COOKIE)?.value;

  if (value !== expectedGateValue()) {
    redirect("/profiles/login");
  }
}
