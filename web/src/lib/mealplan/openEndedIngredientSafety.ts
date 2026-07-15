// Safety gate for OPEN-ENDED ingredient names — i.e. names an LLM proposed,
// not the fixed known 9 in staticIngredientMacros.ts. Deliberately a
// SEPARATE module from ingredientSafety.ts, not a shared one, because the
// two have opposite defaults for an unrecognized name:
//   - ingredientSafety.ts (fixed pool): unrecognized -> null ("not my
//     job", correct because we curated that list ourselves).
//   - this module (open-ended): unrecognized/ambiguous -> UNSAFE. We do
//     NOT control what an LLM proposes, so silence or ambiguity must fail
//     closed, never fail open.
//
// Two layers, same as the fixed-pool version, but broader/conservative
// since there's no curated per-ingredient tag table to check against:
// 1. Exact/substring + synonym match against the user's own allergy/
//    dislike words (same synonym table as ingredientSafety.ts).
// 2. A conservative category-keyword denylist for diet-style compliance
//    (vegetarian/vegan) and common hidden-allergen forms (e.g.
//    mayonnaise contains egg; Worcestershire sauce contains fish) that a
//    prompt-level instruction alone can plausibly miss.
//
// This is NOT exhaustive -- it's a conservative backstop layered UNDER
// prompt-level instructions telling the LLM to respect these constraints,
// not a replacement for them. A false-positive reject (safe ingredient
// wrongly excluded) just means a less interesting proposal; a false
// negative (unsafe ingredient allowed through) is the failure mode this
// exists to prevent, so every ambiguous case below resolves to "unsafe."

import { resolveIntolerances } from "./dietaryMapping";

export interface DietaryContext {
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
}

const DAIRY_SYNONYMS = ["dairy", "milk", "lactose", "cheese", "yogurt", "yoghurt", "cream", "butter", "whey"];
const NUT_SYNONYMS = ["nut", "nuts", "peanut", "peanuts", "tree nut", "tree nuts", "almond", "cashew", "pistachio", "hazelnut", "walnut", "pecan"];
const SOY_SYNONYMS = ["soy", "soya", "tofu", "edamame", "tempeh"];
const SHELLFISH_SYNONYMS = ["shellfish", "shrimp", "prawn", "crab", "lobster", "clam", "mussel", "oyster", "scallop"];
const EGG_SYNONYMS = ["egg", "eggs"];
const GLUTEN_SYNONYMS = ["gluten", "wheat"];

// word -> the ingredient-name substrings it should also be treated as
// meaning, for matching purposes (covers category-level allergy/dislike
// words that don't literally appear in a specific ingredient's name).
//
// dietaryIntolerance (added July 15 2026, audit round 2): this gate used
// to only trigger a category from free-text allergies/dislikes -- a
// dairy_free/gluten_free dietary-STYLE preset never activated the DAIRY_
// SYNONYMS/GLUTEN_SYNONYMS group at all, the same gap found and fixed the
// same day in ingredientSafety.ts (the fixed-pool gate). Reuses
// dietaryMapping.ts's resolveIntolerances (the same single source of
// truth the recipe-search path already uses) rather than a second
// hand-maintained preset list.
const SYNONYM_GROUPS: Array<{ words: string[]; alsoMatches: string[]; dietaryIntolerance?: string }> = [
  { words: DAIRY_SYNONYMS, alsoMatches: DAIRY_SYNONYMS, dietaryIntolerance: "dairy" },
  { words: NUT_SYNONYMS, alsoMatches: NUT_SYNONYMS },
  { words: SOY_SYNONYMS, alsoMatches: SOY_SYNONYMS },
  { words: SHELLFISH_SYNONYMS, alsoMatches: SHELLFISH_SYNONYMS },
  { words: EGG_SYNONYMS, alsoMatches: [...EGG_SYNONYMS, "mayonnaise", "mayo", "meringue", "aioli", "custard", "hollandaise"] },
  { words: GLUTEN_SYNONYMS, alsoMatches: [...GLUTEN_SYNONYMS, "bread", "pasta", "flour", "barley", "rye", "couscous", "seitan"], dietaryIntolerance: "gluten" },
];

const NON_VEGETARIAN_KEYWORDS = [
  "chicken", "beef", "pork", "bacon", "ham", "sausage", "turkey", "lamb", "duck", "veal", "venison",
  "fish", "salmon", "tuna", "cod", "shrimp", "prawn", "crab", "lobster", "anchovy", "sardine",
  "gelatin", "gelatine", "lard", "worcestershire", "fish sauce", "oyster sauce",
];

const NON_VEGAN_EXTRA_KEYWORDS = [
  ...NON_VEGETARIAN_KEYWORDS,
  ...EGG_SYNONYMS,
  ...DAIRY_SYNONYMS,
  "honey",
];

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function containsAny(haystack: string, needles: string[]): string | null {
  return needles.find((n) => haystack.includes(n)) ?? null;
}

// Returns a human-readable reason the ingredient is unsafe/should be
// excluded, or null if it passes every check this module knows about.
// null does NOT mean "verified safe" in an absolute sense -- it means
// "nothing here flagged it," same caveat as any keyword-based check.
export function isOpenEndedIngredientUnsafeFor(ingredientName: string, ctx: DietaryContext): string | null {
  const name = normalize(ingredientName);
  const userWords = [...ctx.allergies, ...ctx.dislikes].map(normalize).filter(Boolean);
  const intolerances = resolveIntolerances(ctx.dietaryStyles).map(normalize);

  for (const word of userWords) {
    if (name.includes(word)) {
      return `matches excluded term "${word}"`;
    }
  }

  for (const group of SYNONYM_GROUPS) {
    const userMentionedThisCategory =
      userWords.some((w) => group.words.includes(w)) ||
      (group.dietaryIntolerance !== undefined && intolerances.includes(group.dietaryIntolerance));
    if (!userMentionedThisCategory) continue;
    const hit = containsAny(name, group.alsoMatches);
    if (hit) {
      return `"${ingredientName}" contains "${hit}", matching an excluded category`;
    }
  }

  if (ctx.dietaryStyles.includes("vegan")) {
    const hit = containsAny(name, NON_VEGAN_EXTRA_KEYWORDS);
    if (hit) return `"${ingredientName}" contains "${hit}", not vegan-compliant`;
  } else if (ctx.dietaryStyles.includes("vegetarian")) {
    const hit = containsAny(name, NON_VEGETARIAN_KEYWORDS);
    if (hit) return `"${ingredientName}" contains "${hit}", not vegetarian-compliant`;
  }

  return null;
}

export function anyIngredientUnsafeFor(ingredientNames: string[], ctx: DietaryContext): string | null {
  for (const name of ingredientNames) {
    const reason = isOpenEndedIngredientUnsafeFor(name, ctx);
    if (reason) return reason;
  }
  return null;
}
