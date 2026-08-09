// Deterministic day-reference resolver for the conversational assistant
// (F11). Reuses the exact day_index=0=today rolling-week convention
// app/plan/calendarExport.ts's dateForDayIndex documents: day_index 0 is
// always today, day_index N is N days from now -- so every weekday name
// resolves somewhere inside [0,6] by construction, no "already passed"
// case exists. This is a strong HINT fed into the chat intent classifier,
// not an authoritative parse -- ambiguous phrasing returns null and the
// classifier takes over from there.

export interface DayReferenceResolution {
  dayIndex: number;
  matchedPhrase: string;
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function resolveDayReference(text: string, today: Date = new Date()): DayReferenceResolution | null {
  const lower = text.toLowerCase();

  // The UI's own tabs (PlanView.tsx's DAY_LABELS) are "Day 1" through
  // "Day 7", 1-indexed to match how a person actually reads a calendar --
  // dayIndex itself is 0-indexed internally (0 = today). A user saying
  // "day 7" means the UI's last tab, i.e. dayIndex 6, NOT an out-of-range
  // reference -- found live 2026-08-09: without this case, "day 7" fell
  // through to the classifier, which (correctly, per its own prompt)
  // reasoned in the internal 0-6 range and told the user "there's no day
  // 7" -- technically accurate about dayIndex, but confusing since the
  // user was reading the number straight off the screen, not off internal
  // state they can't see. Checked first since it's the least ambiguous
  // signal available (an explicit number matching a label the user is
  // looking at) -- outside 1-7 returns null rather than guessing.
  const dayNumberMatch = lower.match(/\bday\s*(\d+)\b/);
  if (dayNumberMatch) {
    const n = parseInt(dayNumberMatch[1], 10);
    if (n >= 1 && n <= 7) {
      return { dayIndex: n - 1, matchedPhrase: dayNumberMatch[0] };
    }
    return null;
  }

  const todayTonightMatch = lower.match(/\b(today|tonight)\b/);
  if (todayTonightMatch) {
    return { dayIndex: 0, matchedPhrase: todayTonightMatch[0] };
  }

  if (/\btomorrow\b/.test(lower)) {
    return { dayIndex: 1, matchedPhrase: "tomorrow" };
  }

  const todayDow = today.getDay();
  for (let i = 0; i < WEEKDAY_NAMES.length; i++) {
    const name = WEEKDAY_NAMES[i];
    if (!new RegExp(`\\b${name}\\b`).test(lower)) continue;

    const dayIndex = (i - todayDow + 7) % 7;

    // "next Tuesday" said on a Tuesday is genuinely ambiguous -- it means
    // 7 days out, which falls outside the 0-6 rolling window this app's
    // plans actually cover. Don't guess; let the classifier ask.
    const precededByNext = new RegExp(`\\bnext\\s+${name}\\b`).test(lower);
    if (dayIndex === 0 && precededByNext) return null;

    return { dayIndex, matchedPhrase: name };
  }

  return null;
}
