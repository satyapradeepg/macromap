import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase session on every request. No-login guest bootstrap
// (PRD 7.1) is disabled: signInAnonymously() ran on every unauthenticated
// request with no way to distinguish real visitors from platform health
// probes, which kept Supabase's anonymous-auth rate limit permanently
// exhausted (99% of container logs, continuous since 2026-07-26).
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) {
      // Most common cause: this Supabase project has anonymous sign-ins
      // disabled (the default for new projects). Enable it in the
      // dashboard: Authentication -> Sign In / Providers -> Anonymous.
      console.error("Guest session bootstrap failed:", error.message);
    }
  }

  return supabaseResponse;
}
