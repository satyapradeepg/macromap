import { Auth0Client } from "@auth0/nextjs-auth0/server";

// Sole identity provider (see supabase/migrations/0034_auth0_identity_swap.sql
// for the RLS side of this). Mounts /auth/login, /auth/logout, /auth/callback
// automatically wherever proxy.ts routes through auth0.middleware().
export const auth0 = new Auth0Client();
