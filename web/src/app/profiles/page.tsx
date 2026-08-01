import { createAdminClient } from "@/lib/supabase/admin";
import { LogoutBar } from "../LogoutBar";
import { Dashboard } from "./Dashboard";

// Access is enforced in middleware.ts (HTTP Basic Auth) before this page
// ever renders. This just needs to always reflect the live test_personas
// table rather than a build-time snapshot.
export const dynamic = "force-dynamic";

export default async function DevProfilesPage() {
  const admin = createAdminClient();
  const { data: personas, error } = await admin
    .from("test_personas")
    .select("id, label, created_at, last_used_at")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (
    <>
      <LogoutBar />
      <Dashboard personas={personas ?? []} />
    </>
  );
}
