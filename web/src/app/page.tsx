import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/identity";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

// A returning, already-onboarded user skips the pitch and goes straight to
// their plan; a logged-in user who hasn't finished onboarding yet continues
// there instead. Only a visitor with no Auth0 session at all sees the copy
// below -- there's no self-serve signup, so their only path forward is
// "Log in" with an account that already exists.
export default async function Home() {
  const user = await getCurrentUser();

  if (user) {
    const supabase = await createClient();
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();
    redirect(profile ? "/plan" : "/onboarding");
  }

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-2xl flex-1 flex-col px-6">
      {/* w-full is the real fix, not min-w-0 -- mx-auto's auto margins
          disable flexbox's default cross-axis stretch on a flex item, so
          without an explicit width this would size to its widest
          descendant's content instead of the viewport (live-confirmed
          2026-07-25, see PlanView.tsx's <main> for the full story). */}
      <div className="flex items-center justify-between pt-8">
        <span className="text-sm font-extrabold tracking-tight">
          Macro<span className="text-accent">Map</span>
        </span>
        <ThemeToggle />
      </div>

      <div className="flex flex-1 flex-col justify-center py-16">
        <span className="inline-flex w-fit items-center gap-1.5 text-xs font-bold tracking-wide text-accent uppercase">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          AI-powered meal planning
        </span>

        <h1 className="mt-4 max-w-xl text-4xl leading-[1.15] font-extrabold tracking-tight text-balance sm:text-5xl">
          From weekly goal to{" "}
          <span
            style={{
              backgroundImage: "linear-gradient(135deg, var(--accent), var(--accent-2))",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            grocery bag
          </span>{" "}
          — without the spreadsheets.
        </h1>

        <p className="mt-4 max-w-md text-lg leading-relaxed text-muted">
          Tell MacroMap your macro target. It builds a week of matching meals
          around what&apos;s already in your pantry, then hands you a
          ready-to-shop grocery list.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          {/* Plain <a>, not <Link>: /auth/login immediately redirects to
              Auth0's own origin, and Link's client-side RSC-payload
              prefetch fetch() can't follow a cross-origin redirect (CORS
              blocks it, logging 3 console errors before Next falls back to
              a real navigation) -- a real browser navigation from the
              first click sidesteps that fetch entirely. */}
          <a
            href="/auth/login"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-bold text-white transition-colors hover:bg-accent-2"
          >
            Log in
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </a>
        </div>

        <div className="mt-16 grid gap-7 border-t border-border pt-8 sm:grid-cols-3">
          <ValueItem
            label="01 · Targets"
            text="Every meal matched to your calorie, protein, carb, and fat targets — set once at onboarding."
          />
          <ValueItem
            label="02 · Pantry"
            text="Log what you've already got — it's used first, and subtracted from the grocery list."
          />
          <ValueItem
            label="03 · Recipes"
            text="Every meal opens into real ingredients and cooking steps — not just a calorie count."
          />
        </div>
      </div>

      <footer className="border-t border-border py-5 text-xs text-muted">
        MacroMap — built for people who eat by the numbers.
      </footer>
    </main>
  );
}

function ValueItem({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <span className="font-mono text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <p className="mt-2 text-sm leading-relaxed text-foreground">{text}</p>
    </div>
  );
}
