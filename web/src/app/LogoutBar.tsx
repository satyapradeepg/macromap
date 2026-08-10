"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

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
//
// Converted to a client component (2026-08-10, redesign) to add the
// mobile hamburger sheet + theme toggle -- neither needs server data, so
// this is a straightforward whole-file conversion rather than splitting
// into a server shell + client island.
const NAV_LINKS = [
  { href: "/plan", label: "Plan" },
  { href: "/account", label: "Account" },
];

export function LogoutBar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile sheet on navigation so it doesn't stay open after
  // tapping a link. Adjusted during render (React's documented pattern
  // for "reset state when a prop changes") rather than in an effect --
  // avoids an extra committed render with the sheet still open.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setOpen(false);
  }

  return (
    <div className="relative border-b border-border">
      <div className="flex items-center justify-between px-6 py-3">
        <Link href="/plan">
          <Logo />
        </Link>

        <div className="hidden items-center gap-4 md:flex">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="text-sm text-muted hover:underline">
              {link.label}
            </Link>
          ))}
          <a href="/auth/logout" className="text-sm text-muted hover:underline">
            Log out
          </a>
          <ThemeToggle />
        </div>

        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-foreground"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {open ? (
                <path d="M6 6l12 12M18 6L6 18" />
              ) : (
                <path d="M3 6h18M3 12h18M3 18h18" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <nav className="animate-chat-in motion-reduce:animate-none absolute inset-x-0 top-full z-40 flex flex-col gap-1 border-b border-border bg-surface p-2 shadow-lg md:hidden">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-lg px-3 py-2.5 text-sm font-semibold ${
                pathname === link.href ? "bg-accent/10 text-accent" : "text-foreground"
              }`}
            >
              {link.label}
            </Link>
          ))}
          <a href="/auth/logout" className="rounded-lg px-3 py-2.5 text-sm font-semibold text-foreground">
            Log out
          </a>
        </nav>
      )}
    </div>
  );
}
