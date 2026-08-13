"use client";

import { useEffect, useRef, useState } from "react";
import type { MacroTargets } from "@/lib/mealplan/targets";
import { weeklyAccuracyTier } from "@/lib/mealplan/reconciliation";

// Extracted from PlanView.tsx's inline MacroStat (2026-08-10 redesign) --
// same actual/target math, now rendered as a ring per macro (matching the
// approved direction.html mockup) instead of a flat bar, plus an explicit
// over/under/on-target delta chip. The old flat-bar version silently
// clamped display at 100%, so a macro running 30% over target looked
// identical to one exactly on target -- the delta chip is a real
// information gap this closes, not just a cosmetic change. ±5% matches
// the same weekly reconciliation band used server-side
// (reconciliation.ts's toleranceBand/isWithinBand).
const ACCURACY_HEADLINE: Record<ReturnType<typeof weeklyAccuracyTier>, string> = {
  on_target: "This week is within your weekly targets",
  close: "This week lands close to your weekly targets",
  off_target: "This week is meaningfully off your weekly targets",
};

type RingSpec = {
  label: string;
  unit: string;
  actual: number;
  target: number;
  color: string;
};

function ring(pct: number, color: string, r = 34) {
  const c = 2 * Math.PI * r;
  const base = Math.min(pct, 1);
  const off = c * (1 - base);
  // Overflow (>100% of target) re-traces the same arc from the top in a
  // darkened shade of the macro color, drawn over the now-fully-closed base
  // ring -- so how far over target reads as how much of the ring went dark,
  // instead of a full ring at 100% looking identical to one at 130%.
  const overflow = Math.min(Math.max(pct - 1, 0), 1);
  const overflowOff = c * (1 - overflow);
  const darkColor = `color-mix(in srgb, ${color} 55%, black)`;
  return (
    <>
      <circle cx="42" cy="42" r={r} fill="none" stroke="var(--border)" strokeWidth="7" />
      <circle
        cx="42"
        cy="42"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={off}
        transform="rotate(-90 42 42)"
        className="[transition:stroke-dashoffset_900ms_ease-out] motion-reduce:transition-none"
      />
      {overflow > 0 && (
        <circle
          cx="42"
          cy="42"
          r={r}
          fill="none"
          stroke={darkColor}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={overflowOff}
          transform="rotate(-90 42 42)"
          className="[transition:stroke-dashoffset_900ms_ease-out] motion-reduce:transition-none"
        />
      )}
    </>
  );
}

// Counts the displayed number up to `value` over the same 900ms/ease-out
// the ring's own stroke-dashoffset transition uses (see ring() above) --
// design review 2026-08-13 flagged that the arc filled smoothly while the
// number beside it just popped in at its final value, unsynced, which read
// as "correct" rather than "alive." Tweens from whatever's currently
// displayed (not always 0), so a later change (e.g. a swap) animates from
// where it visually is, same as the ring's own CSS transition behavior.
function useCountUp(value: number, durationMs = 900) {
  const [display, setDisplay] = useState(0);
  const displayRef = useRef(0);

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = displayRef.current;
    const to = value;
    if (prefersReducedMotion || from === to) {
      displayRef.current = to;
      setDisplay(to);
      return;
    }
    let raf: number;
    const start = performance.now();
    function tick(now: number) {
      const t = Math.min((now - start) / durationMs, 1);
      // Cubic ease-out, matching the ring's own CSS `ease-out` curve so
      // the number and the arc read as the same motion, not two unrelated
      // animations that happen to end around the same time.
      const eased = 1 - Math.pow(1 - t, 3);
      const next = t < 1 ? from + (to - from) * eased : to;
      displayRef.current = next;
      setDisplay(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  return display;
}

function MacroRing({ label, unit, actual, target, color }: RingSpec) {
  const pct = target > 0 ? actual / target : 0;
  // Rendered at 0 on mount and flipped to the real value one tick later so
  // the CSS transition on the ring's own stroke-dashoffset (see ring())
  // actually has a value change to animate -- setting the final value
  // directly on the very first render paints it immediately with nothing
  // to transition from. Re-fires on pct change too (e.g. swapping a meal
  // updates weeklyActual), so a value change always animates, not just
  // the initial mount.
  const [animatedPct, setAnimatedPct] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimatedPct(pct));
    return () => cancelAnimationFrame(raf);
  }, [pct]);
  const over = pct > 1.05;
  const under = pct < 0.95;
  const state = over ? "over" : under ? "under" : "ontarget";
  // Only the "so far" number counts up -- the target/goal number is static
  // in Apple's own rings too, it's the progress that should feel like it's
  // moving. over/under/deltaText below stay derived from the real `actual`,
  // never the animated display value, so the badge never flickers state
  // mid-count.
  const displayedActual = useCountUp(actual);
  const roundedActual = Math.round(displayedActual);
  const roundedTarget = Math.round(target);
  const deltaAbs = Math.round(Math.abs(actual - target));
  const deltaText = over ? `+${deltaAbs}${unit} over` : under ? `−${deltaAbs}${unit} under` : "on target";

  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <svg viewBox="0 0 84 84" className="h-20 w-20">
        {ring(animatedPct, color)}
      </svg>
      <span className="text-[10.5px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <span className="font-mono text-[13px] font-semibold tabular-nums">
        {roundedActual}
        {unit} <span className="font-normal text-muted">/ {roundedTarget}{unit}</span>
      </span>
      <span
        className={`rounded-full px-2 py-0.5 font-mono text-[10.5px] font-bold tabular-nums ${
          state === "ontarget" ? "bg-good/15 text-good" : "bg-warn/15 text-warn"
        }`}
      >
        {deltaText}
      </span>
    </div>
  );
}

export function MacroRings({ actual, target }: { actual: MacroTargets; target: MacroTargets }) {
  const tier = weeklyAccuracyTier(actual, target);
  const rings: RingSpec[] = [
    { label: "Calories", unit: " cal", actual: actual.calories, target: target.calories, color: "var(--accent)" },
    { label: "Protein", unit: "g", actual: actual.proteinG, target: target.proteinG, color: "var(--protein)" },
    { label: "Carbs", unit: "g", actual: actual.carbsG, target: target.carbsG, color: "var(--carbs)" },
    { label: "Fat", unit: "g", actual: actual.fatG, target: target.fatG, color: "var(--fat)" },
  ];

  return (
    <div className="mt-6 rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)] sm:p-6">
      <p className="text-sm font-semibold text-foreground">{ACCURACY_HEADLINE[tier]}</p>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {rings.map((r) => (
          <MacroRing key={r.label} {...r} />
        ))}
      </div>
    </div>
  );
}
