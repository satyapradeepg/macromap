import Link from "next/link";
import { Logo } from "@/components/Logo";

// /auth/logout is mounted directly by the Auth0 SDK (proxy.ts) -- a plain
// link works, no Server Action needed now that there's no separate
// Supabase-session-only sign-out step to run first.
export function LogoutBar() {
  return (
    <div className="flex items-center justify-between border-b border-border px-6 py-3">
      <Link href="/plan">
        <Logo />
      </Link>
      <div className="flex items-center gap-4">
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
