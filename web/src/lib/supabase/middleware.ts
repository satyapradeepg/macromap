import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase session on every request and bootstraps a guest
// session for first-time visitors. PRD 7.1: users can complete Steps 1-4
// (Onboarding -> Grocery List) with no account; the signup wall is at Step 5
// (Track). Supabase anonymous auth gives that guest a real user id from the
// first request, so upgrading to a permanent account at Step 5 links the
// same row instead of needing a manual data-migration step.
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
