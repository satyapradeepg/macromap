import { requireTestProfilesEnabled } from "../gate";
import { LoginForm } from "./LoginForm";

export default function DevProfilesLoginPage() {
  requireTestProfilesEnabled();

  return (
    <main className="mx-auto w-full max-w-sm px-6 py-24">
      <h1 className="mb-4 text-lg font-semibold">Test profiles</h1>
      <LoginForm />
    </main>
  );
}
