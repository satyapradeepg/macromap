import { Logo } from "@/components/Logo";
import { Card } from "@/components/ui/Card";
import { requireTestProfilesEnabled } from "../gate";
import { LoginForm } from "./LoginForm";

// See ../page.tsx's identical comment -- this page checks
// ACCESS_USERNAME/ACCESS_PASSWORD via a plain process.env read and uses
// no dynamic API at all, so without this it gets permanently statically
// prerendered using build-time env (where these vars are deliberately
// absent), baking in a 404 that ignores the real runtime environment.
export const dynamic = "force-dynamic";

export default function ProfilesLoginPage() {
  requireTestProfilesEnabled();

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col items-center px-6 py-24">
      <Logo className="text-base" />
      <Card className="mt-8 w-full p-6">
        <h1 className="mb-4 text-lg font-semibold text-foreground">Sign in</h1>
        <LoginForm />
      </Card>
    </main>
  );
}
