import { auth0 } from "@/lib/auth0";

export interface CurrentUser {
  // Auth0's subject claim (e.g. "auth0|64f2a1b3c4d5e6f7a8b9c0d1") -- this IS
  // profiles.id and every *_user_id column now (migration 0034), the same
  // role auth.users.id played before this app had its own identity provider.
  id: string;
  email: string | null;
  name: string | null;
}

// The signed-in user for the current request, or null with no session.
// proxy.ts already redirects every non-public route to /auth/login before it
// renders, so null is normally unreachable here outside of a defensive
// check -- same shape/convention every call site already used for the old
// supabase.auth.getUser()'s `user`.
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth0.getSession();
  if (!session) return null;

  return {
    id: session.user.sub,
    email: typeof session.user.email === "string" ? session.user.email : null,
    name: typeof session.user.name === "string" ? session.user.name : null,
  };
}
