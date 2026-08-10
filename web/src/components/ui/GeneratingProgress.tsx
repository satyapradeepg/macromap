"use client";

import { useEffect, useState } from "react";
import { Spinner } from "./Spinner";

// Extracted from OnboardingWizard.tsx (2026-08-10 redesign) so
// PlanBoard.handleGenerate can share it -- previously the only generating
// feedback on /plan was Button's static loadingText="Generating" for what
// can be a 60-90+ second wait (a real, previously-unfixed UX gap), while
// onboarding already had this full rotating-message overlay. Named after
// the pipeline's own real stages (pantry-aware querying, tolerance
// widening, AI-composition fallback) rather than generic "please wait"
// filler. Advances once per interval and holds on the last message rather
// than looping, so it reads as progress, not a stuck repeat.
const GENERATING_STATUS_MESSAGES = [
  "Checking your pantry for ingredients you already have…",
  "Matching recipes to your macro targets…",
  "Filtering for your dietary restrictions and allergies…",
  "Balancing macros across the week…",
  "Almost ready…",
];

export function GeneratingProgress({ heading }: { heading: string }) {
  const [statusIndex, setStatusIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setStatusIndex((i) => Math.min(i + 1, GENERATING_STATUS_MESSAGES.length - 1));
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    // Fixed full-viewport overlay, not a block in normal flow -- a spinner
    // competing with unrelated page chrome around it reads as more broken
    // than static text did (see OnboardingWizard's original comment on
    // this, still true on /plan too).
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <main className="mx-auto w-full min-w-0 max-w-md px-6 text-center">
        <Spinner className="mx-auto h-8 w-8 text-accent" />
        <h1 className="font-display mt-4 text-2xl font-bold">{heading}</h1>
        <p className="mt-2 text-muted">{GENERATING_STATUS_MESSAGES[statusIndex]}</p>
        <div className="mt-6 h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div className="animate-progress-slide motion-reduce:animate-none h-full w-1/3 rounded-full bg-accent" />
        </div>
      </main>
    </div>
  );
}
