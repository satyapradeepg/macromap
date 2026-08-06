import { LogoutBar } from "../LogoutBar";
import { OnboardingWizard } from "./OnboardingWizard";

// Access is enforced in middleware.ts (HTTP Basic Auth) before this page
// ever renders. Kept dynamic since it's always rendered per-session, never
// a build-time snapshot.
export const dynamic = "force-dynamic";

export default function OnboardingPage() {
  return (
    <>
      <LogoutBar />
      <OnboardingWizard />
    </>
  );
}
