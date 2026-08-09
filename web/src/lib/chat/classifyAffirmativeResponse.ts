// Cheap deterministic yes/no check for the clamp-confirmation flow (F11
// meal editing): when the assistant's PREVIOUS message offered a specific
// suggestion ("want me to use 280g instead?"), most replies are a plain
// yes/no -- this catches that common case without spending a classifier
// call on it. Anything not confidently one or the other returns null,
// and chatActions.ts falls through to the full intent classifier (which
// can still resolve it via the confirm_pending_action intent, with the
// pending suggestion given as context).

const AFFIRMATIVE_WORDS = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "do it", "go ahead", "sounds good", "please do", "confirm"];
const NEGATIVE_WORDS = ["no", "nope", "nah", "don't", "do not", "cancel", "never mind", "nevermind", "skip it"];

export function classifyAffirmativeResponse(text: string): boolean | null {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, "");

  for (const word of NEGATIVE_WORDS) {
    if (normalized === word || normalized.startsWith(`${word} `)) return false;
  }
  for (const word of AFFIRMATIVE_WORDS) {
    if (normalized === word || normalized.startsWith(`${word} `)) return true;
  }
  return null;
}
