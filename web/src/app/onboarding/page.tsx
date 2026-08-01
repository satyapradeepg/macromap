import { LogoutBar } from "../LogoutBar";
import { OnboardingWizard } from "./OnboardingWizard";

export default function OnboardingPage() {
  return (
    <>
      <LogoutBar showBackToProfiles />
      <OnboardingWizard />
    </>
  );
}
