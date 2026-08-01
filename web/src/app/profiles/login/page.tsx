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
    <main className="mx-auto w-full max-w-sm px-6 py-24">
      <h1 className="mb-4 text-lg font-semibold">Sign in</h1>
      <LoginForm />
    </main>
  );
}
