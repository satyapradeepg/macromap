import { LogoutBar } from "../LogoutBar";
import { Spinner } from "@/components/ui/Spinner";

// Next's App Router convention: automatically wraps page.tsx in a Suspense
// boundary and shows this immediately on navigation, before the server
// component's own awaits (profile lookup, plan/pantry/grocery queries)
// resolve. Without this file, there was NO visual feedback at all between
// clicking "Plan" and the full page appearing -- the browser just sat on
// whatever page you navigated from, which read as the click not having
// registered (live-confirmed 2026-08-13, reported as slow account->plan
// navigation). Renders the real LogoutBar (not a placeholder) so the nav
// bar itself doesn't flash/shift once the actual page mounts.
export default function Loading() {
  return (
    <>
      <LogoutBar />
      <main className="mx-auto flex w-full min-w-0 max-w-3xl flex-1 items-center justify-center px-6 py-24">
        <Spinner className="h-8 w-8 text-accent" />
      </main>
    </>
  );
}
