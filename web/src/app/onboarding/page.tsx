import { LogoutBar } from "../LogoutBar";
import { requireGateCookie } from "../profiles/gate";
import { OnboardingWizard } from "./OnboardingWizard";

// requireGateCookie() reads ACCESS_USERNAME/ACCESS_PASSWORD (plain
// process.env, no dynamic API) before ever calling cookies() -- without
// forcing dynamic, Next.js's static optimizer can permanently bake in a
// build-time 404 (those vars are runtime-only, unset at Docker build time)
// regardless of the real running environment. See /profiles/page.tsx.
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  await requireGateCookie();

  return (
    <>
      <LogoutBar showBackToProfiles />
      <OnboardingWizard />
    </>
  );
}
