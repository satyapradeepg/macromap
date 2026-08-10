// Extracted from PlanView.tsx's inline Pill-row day selector (2026-08-10
// redesign) -- same dayStatus() semantics and the same deliberately
// horizontal-scrolling overflow-x-auto behavior (see layout.tsx's
// overflow-x-hidden/min-w-0 comment for why this must stay a
// self-contained scroll region, not grow the page width on narrow
// screens). Visual only: planner-tab cards instead of plain pills.
//
// Also fixes a pre-existing semantic mismatch: the "within_band" status
// dot used text-accent-2 (a bright accent-orange shade meant for
// hover/gradient use elsewhere, e.g. Button's primary hover) to mean
// "good" -- now uses the real --good token so an actually-positive
// signal isn't tied to the same color as an unrelated hover state.
export type DayStatus = "within_band" | "outside_band" | "incomplete";

export function DayRibbon({
  dayLabels,
  selectedDay,
  onSelect,
  statusFor,
}: {
  dayLabels: string[];
  selectedDay: number;
  onSelect: (dayIndex: number) => void;
  statusFor: (dayIndex: number) => DayStatus;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {dayLabels.map((label, dayIndex) => {
        const status = statusFor(dayIndex);
        const isSelected = dayIndex === selectedDay;
        const dayNumber = label.replace(/\D/g, "");
        return (
          <button
            key={dayIndex}
            type="button"
            onClick={() => onSelect(dayIndex)}
            className={`flex shrink-0 flex-col items-center gap-1 rounded-xl border px-3 py-2 transition-colors ${
              isSelected
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-surface text-foreground hover:border-muted"
            }`}
          >
            <span className={`text-[9.5px] font-semibold tracking-wide uppercase ${isSelected ? "opacity-70" : "text-muted"}`}>
              Day
            </span>
            <span className="font-display text-lg leading-none font-bold">{dayNumber}</span>
            <span
              className={`mt-0.5 h-1.5 w-1.5 rounded-full ${
                status === "within_band" ? "bg-good" : "bg-transparent"
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}
