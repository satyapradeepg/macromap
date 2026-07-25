import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
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
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
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
      </body>
    </html>
  );
}
