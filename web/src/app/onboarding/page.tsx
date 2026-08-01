import { LogoutBar } from "../LogoutBar";
import { requireGateCookie } from "../profiles/gate";
import { OnboardingWizard } from "./OnboardingWizard";

export default async function OnboardingPage() {
  await requireGateCookie();

  return (
    <>
      <LogoutBar showBackToProfiles />
      <OnboardingWizard />
    </>
  );
}
