"use client";

import { useEffect, useState } from "react";

// Fired on window after every manual toggle so all mounted instances stay
// in sync -- LogoutBar.tsx renders TWO of these at once (desktop nav +
// mobile nav), both always in the DOM with CSS just hiding one via
// display:none, not unmounting it. Without this, clicking one left the
// other's local isDark stale until it happened to remount, so it could
// show the wrong icon, or "undo" the first click instead of continuing to
// toggle once it became visible.
const THEME_CHANGE_EVENT = "macromap:theme-change";

// The attribute is only ever set once a manual choice has been made
// (layout.tsx's inline pre-hydration script only writes it from
// localStorage, and only if a prior manual choice exists there). Before
// that, it's genuinely unset and globals.css's prefers-color-scheme media
// query is what's actually rendering -- falling back to the system
// preference here (instead of defaulting to false/light) is required for
// the toggle to ever reflect reality on a first visit with a dark OS.
function readIsDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// No next-themes dependency, no React Context -- theme lives on the DOM
// (documentElement's data-theme attribute), not in component state, so
// server components never need to know it. layout.tsx's inline <script>
// sets the attribute before first paint (avoiding a flash of the wrong
// theme); this component only needs to read that attribute on mount and
// flip it + persist to localStorage on click.
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDark(readIsDark());
    function onThemeChange() {
      setIsDark(readIsDark());
    }
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
  }, []);

  function toggle() {
    const next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    window.localStorage.setItem("theme", next);
    setIsDark(next === "dark");
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:text-foreground ${className}`}
    >
      {isDark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  );
}
