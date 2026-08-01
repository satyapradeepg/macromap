import { createAdminClient } from "@/lib/supabase/admin";
import { LogoutBar } from "../LogoutBar";
import { requireGateCookie } from "./gate";
import { Dashboard } from "./Dashboard";

// requireGateCookie() checks ACCESS_USERNAME/ACCESS_PASSWORD (a plain
// process.env read, no dynamic API) BEFORE ever calling cookies() --
// live-confirmed 2026-08-01: with those env vars unset at build time
// (they're runtime-only, deliberately not passed as Docker build args so
// they can be rotated without a rebuild), Next.js's static optimizer
// never sees a dynamic API touched on this render path and permanently
// bakes in that build-time 404, serving it forever (`x-nextjs-cache:
// HIT`, s-maxage=31536000) regardless of what the running container's
// real env vars are. Forcing this dynamic makes every request actually
// re-run the check against the live environment.
export const dynamic = "force-dynamic";

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
