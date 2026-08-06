import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { auth0 } from "@/lib/auth0";

// For use in Server Components, Route Handlers, and Server Actions. There is
// no Supabase-managed session/cookie anymore -- Auth0 is the sole identity
// provider (see migration 0034), wired in via Supabase's Third-Party Auth
// feature. RLS policies read (auth.jwt() ->> 'sub') off this same ID token,
// so passing it via `accessToken` is what makes auth.jwt() resolve at all;
// Supabase's own auth.uid()/auth.getUser() do not apply to third-party JWTs.
export async function createClient() {
  const session = await auth0.getSession();
  const idToken = session?.tokenSet.idToken;

  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      accessToken: async () => idToken ?? null,
    },
  );
}
