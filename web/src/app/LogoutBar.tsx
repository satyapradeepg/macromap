import Link from "next/link";
import { Logo } from "@/components/Logo";

// /auth/logout is mounted directly by the Auth0 SDK (proxy.ts) -- a plain
// link works, no Server Action needed now that there's no separate
// Supabase-session-only sign-out step to run first.
//
// "Plan" link added 2026-08-09 (real user report): the only way from
// /account back to /plan was clicking the logo -- a real navigation path,
// but not a discoverable one (logos read as branding, not necessarily as
// a "go back" affordance). Rendered unconditionally on both pages, same
// as "Account" already was (clicking it while already on /account is a
// harmless no-op re-navigation, exactly like "Account" already behaves
// when already on /account) -- avoids needing this server component to
// know the current path just to conditionally hide one link.
export function LogoutBar() {
  return (
    <div className="flex items-center justify-between border-b border-border px-6 py-3">
      <Link href="/plan">
        <Logo />
      </Link>
      <div className="flex items-center gap-4">
        <Link href="/plan" className="text-sm text-muted hover:underline">
          Plan
        </Link>
        <Link href="/account" className="text-sm text-muted hover:underline">
          Account
        </Link>
        <a href="/auth/logout" className="text-sm text-muted hover:underline">
          Log out
        </a>
      </div>
    </div>
  );
}
