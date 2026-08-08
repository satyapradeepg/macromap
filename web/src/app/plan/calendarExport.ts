// Calendar export (2026-08-08, Satya's ask): a one-shot .ics download of the
// week's meal plan, same zero-dependency Blob+<a download> pattern as
// GroceryList.tsx's "Export". Hand-built RFC 5545 text -- no ics/ical
// library exists in this repo and none is needed for a flat VEVENT list.

import type { PlanSlotView, PlanView } from "./data";
import type { MealType } from "@/lib/mealplan/targets";
import { pluralizeUnit } from "./unitFormatting";

const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack1: "Snack 1",
  snack2: "Snack 2",
};

// No time-of-day concept exists anywhere else in the app (MealType only
// carries macro share/calorie bounds, targets.ts) -- these are new,
// reasonable defaults invented for this export specifically.
const MEAL_TIMES: Record<MealType, { hour: number; minute: number }> = {
  breakfast: { hour: 8, minute: 0 },
  snack1: { hour: 10, minute: 0 },
  lunch: { hour: 12, minute: 30 },
  snack2: { hour: 15, minute: 30 },
  dinner: { hour: 18, minute: 30 },
};

const EVENT_DURATION_MINUTES = 30;

// day_index has no real calendar date anywhere in the schema (0-6 is just
// a Monday=0 label, per targets.ts/PlanView.tsx's DAY_LABELS) -- Satya's
// call: today anchors to its own real weekday, the rest of the plan's
// days fall forward/backward from there. A day_index earlier in the week
// than today has therefore already passed and is skipped below, rather
// than exporting a calendar reminder for a meal that's already happened.
function dateForDayIndex(dayIndex: number, today: Date): Date | null {
  const todayWeekday = (today.getDay() + 6) % 7; // Date.getDay(): 0=Sun -> 0=Mon
  if (dayIndex < todayWeekday) return null;
  const target = new Date(today);
  target.setDate(today.getDate() + (dayIndex - todayWeekday));
  return target;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Floating local time (no Z, no TZID) -- interpreted by the receiving
// calendar app as its device's local timezone, which is the right
// behavior for "eat lunch at 12:30" regardless of where the plan was
// generated or exported from.
function formatLocalDateTime(date: Date, hour: number, minute: number): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(hour)}${pad(minute)}00`;
}

function formatUtcTimestamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

// RFC 5545 TEXT escaping -- backslash/semicolon/comma get a backslash, and
// a real newline becomes the literal two-character sequence "\n" (this is
// NOT an actual line break, which would violate ICS line folding).
function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// 1 decimal, same rounding as GroceryList.tsx's formatAmount/PlanView.tsx's
// formatIngredientAmount -- a scaled ingredient amount (e.g. 12.67 almonds)
// reads as more precise than a home cook would ever actually measure.
function formatIngredientAmount(amount: number, unit: string): string {
  const rounded = Math.round(amount * 10) / 10;
  return unit ? `${rounded} ${pluralizeUnit(unit, rounded)}` : `${rounded}`;
}

function ingredientLines(slot: PlanSlotView): string[] {
  if (slot.composedIngredients) {
    return slot.composedIngredients.map((i) => `${Math.round(i.amountG)}g ${i.name}`);
  }
  return (slot.recipeIngredients ?? []).map((i) => `${formatIngredientAmount(i.amount, i.unit)} ${i.name}`);
}

function buildDescription(slot: PlanSlotView): string {
  const lines = [
    `${Math.round(slot.calories)} cal, ${Math.round(slot.proteinG)}g protein, ${Math.round(slot.carbsG)}g carbs, ${Math.round(slot.fatG)}g fat`,
    "",
    ...ingredientLines(slot),
  ];
  if (slot.addon) {
    lines.push(`+ ${Math.round(slot.addon.amountG)}g ${slot.addon.ingredientName}`);
  }
  return lines.join("\n");
}

function buildEvent(planId: string, slot: PlanSlotView, date: Date, dtstamp: string): string {
  const { hour, minute } = MEAL_TIMES[slot.mealType];
  const start = formatLocalDateTime(date, hour, minute);
  const endDate = new Date(date);
  const endMinutesTotal = hour * 60 + minute + EVENT_DURATION_MINUTES;
  const end = formatLocalDateTime(endDate, Math.floor(endMinutesTotal / 60), endMinutesTotal % 60);

  return [
    "BEGIN:VEVENT",
    `UID:${planId}-${slot.dayIndex}-${slot.mealType}@macromap.app`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeText(`${MEAL_TYPE_LABELS[slot.mealType]}: ${slot.recipeTitle}`)}`,
    `DESCRIPTION:${escapeText(buildDescription(slot))}`,
    "END:VEVENT",
  ].join("\r\n");
}

export function buildMealPlanIcs(plan: PlanView, today: Date = new Date()): string {
  const dtstamp = formatUtcTimestamp(today);
  const events = plan.slots
    .filter((slot) => !slot.isUnfilled)
    .flatMap((slot) => {
      const date = dateForDayIndex(slot.dayIndex, today);
      return date ? [buildEvent(plan.id, slot, date, dtstamp)] : [];
    });

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MacroMap//Meal Plan//EN",
    "CALSCALE:GREGORIAN",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}
