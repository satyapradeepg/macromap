import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-bold tracking-tight">MacroMap</h1>
      <p className="max-w-md text-muted">
        Scaffold check: Supabase {user ? "connected" : "not connected"}
        {user && (
          <>
            {" "}
            — guest session bootstrapped (<code>{user.id.slice(0, 8)}…</code>,{" "}
            {user.is_anonymous ? "anonymous" : "signed in"})
          </>
        )}
        .
      </p>
      <Link
        href="/onboarding"
        className="mt-2 rounded-lg bg-accent px-4 py-2 font-semibold text-white"
      >
        Start onboarding
      </Link>
    </main>
  );
}
