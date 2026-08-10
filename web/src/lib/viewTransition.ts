// Feature-detected wrapper around the View Transitions API (Chromium today,
// no Safari/Firefox support yet) -- falls back to calling the state update
// directly when unavailable, which is exactly today's existing behavior,
// so there's no regression path, only a progressive enhancement.
//
// Also explicitly skips the API under prefers-reduced-motion rather than
// trusting the browser's own compliance -- some implementations still run
// a (shorter) transition rather than a true no-op, so the safest way to
// guarantee zero motion is to never invoke the API at all in that case.
export function runWithViewTransition(update: () => void) {
  const prefersReducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const supportsViewTransitions =
    typeof document !== "undefined" &&
    "startViewTransition" in document &&
    typeof document.startViewTransition === "function";

  if (prefersReducedMotion || !supportsViewTransitions) {
    update();
    return;
  }

  document.startViewTransition(update);
}
