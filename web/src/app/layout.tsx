import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Fraunces } from "next/font/google";
import { ToastHost } from "@/components/ui/Toast";
import "./globals.css";

// Runs before hydration/paint so an explicit stored preference applies
// immediately -- without this, the page would render with globals.css's
// prefers-color-scheme default first, then visibly flip once React
// hydrates and reads localStorage. Only sets the attribute when the user
// has made an explicit choice; otherwise data-theme stays unset and
// globals.css's prefers-color-scheme media query drives the OS default,
// matching ThemeToggle.tsx's model of the attribute as an override, not
// a mirror of every possible state.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

// Display face for headings/titles/large numerals ("precision ledger"
// redesign, 2026-08-10) -- an editorial serif with real character rather
// than a reflexive "safe" choice (Playfair/Merriweather/Lora), fitting a
// macro-precision app without reading as decorative.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz", "SOFT"],
});

export const metadata: Metadata = {
  title: "MacroMap",
  description:
    "MacroMap turns a weekly macro target into a full meal plan and a ready-to-shop grocery list, built around what's already in your pantry.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      {/* overflow-x-hidden is a hard backstop: the page body must never
          scroll horizontally, regardless of what a future page's own
          internal flex/grid structure does -- min-w-0 below (and on each
          page's own <main>) is the real fix for the flexbox min-width:auto
          cascade, this is insurance against the same class of bug
          resurfacing somewhere this doesn't reach. */}
      <body className="min-h-full flex flex-col overflow-x-hidden">
        {/* min-w-0 counters flexbox's default per-item min-width: auto
            (content-based, not 0) -- without it, any page containing a
            wide-min-content descendant (e.g. PlanView's horizontally-
            scrolling day selector, deliberately overflow-x-auto so IT
            scrolls internally) instead refuses to let this whole wrapper
            shrink below that content's width, forcing the entire page
            wider than the viewport on narrow screens instead of scrolling
            just that one row. Centralized here (rather than on every
            page's own <main>) so it's automatic for every current and
            future page, not something to remember to re-add each time. */}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        <ToastHost />
      </body>
    </html>
  );
}
