import { createAdminClient } from "@/lib/supabase/admin";
import { LogoutBar } from "../LogoutBar";
import { requireGateCookie } from "./gate";
import { Dashboard } from "./Dashboard";

export default async function DevProfilesPage() {
  await requireGateCookie();

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
