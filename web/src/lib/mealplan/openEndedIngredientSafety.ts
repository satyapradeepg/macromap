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
import { commaSwapFallback } from "../spoonacular";

export interface DietaryContext {
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
}

const DAIRY_SYNONYMS = [
  "dairy", "milk", "lactose", "cheese", "yogurt", "yoghurt", "cream", "butter", "whey",
  "ghee", "paneer", "kefir", "ricotta", "mascarpone", "casein", "gelato",
];
const NUT_SYNONYMS = ["nut", "nuts", "peanut", "peanuts", "tree nut", "tree nuts", "almond", "cashew", "pistachio", "hazelnut", "walnut", "pecan"];
const SOY_SYNONYMS = ["soy", "soya", "tofu", "edamame", "tempeh", "miso", "natto", "tamari", "soy lecithin", "tvp", "textured vegetable protein"];
const SHELLFISH_SYNONYMS = ["shellfish", "shrimp", "prawn", "crab", "lobster", "clam", "mussel", "oyster", "oysters", "scallop", "squid", "octopus", "snail", "escargot"];
// Added July 15 2026 (audit round 3): a declared fish allergy previously
// had no synonym group at all -- only a literal word-boundary match of
// the user's own typed word against the ingredient name, so "fish" never
// matched "salmon"/"tuna"/etc. Includes the hidden/foreign-name forms
// that also feed NON_VEGETARIAN_KEYWORDS below (dashi/bonito/katsuobushi
// are Japanese fish stock/flakes; nam pla/nuoc mam are Thai/Vietnamese
// fish sauce) so those get real allergy coverage too, not just a diet-
// style check.
const FISH_SYNONYMS = [
  "fish", "salmon", "tuna", "cod", "anchovy", "anchovies", "sardine", "catfish", "trout",
  "halibut", "mackerel", "tilapia", "herring", "snapper", "swordfish", "mahi mahi",
  "bonito", "dashi", "katsuobushi", "fish sauce", "nam pla", "nuoc mam", "worcestershire",
];
// Added July 15 2026 (audit round 3): sesame had zero coverage anywhere --
// not an onboarding preset, no synonym group, and "tahini" (pure ground
// sesame) contains no substring "sesame". One of the 9 FDA-recognized
// major allergens (2023 FASTER Act).
const SESAME_SYNONYMS = ["sesame", "tahini", "sesame oil", "sesame seed", "sesame seeds", "benne", "gomashio"];
const EGG_SYNONYMS = ["egg", "eggs"];
const GLUTEN_SYNONYMS = [
  "gluten", "wheat", "malt", "semolina", "farro", "spelt", "bulgur", "panko", "udon", "orzo", "matzo",
];

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
  { words: FISH_SYNONYMS, alsoMatches: FISH_SYNONYMS },
  { words: SESAME_SYNONYMS, alsoMatches: SESAME_SYNONYMS },
  { words: EGG_SYNONYMS, alsoMatches: [...EGG_SYNONYMS, "mayonnaise", "mayo", "meringue", "aioli", "custard", "hollandaise"] },
  { words: GLUTEN_SYNONYMS, alsoMatches: [...GLUTEN_SYNONYMS, "bread", "pasta", "flour", "barley", "rye", "couscous", "seitan"], dietaryIntolerance: "gluten" },
];

// Wires FISH_SYNONYMS/SHELLFISH_SYNONYMS in directly (audit round 3, finding
// 7) rather than hand-duplicating a second fish/shellfish list here -- this
// is what makes vegetarian/vegan checks catch bare "oysters"/"clam sauce"
// etc. automatically instead of only when the user separately declared a
// shellfish allergy. Also expanded finding 6's other absent common
// categories: goat/rabbit/bison/quail, cured-meat forms (chorizo/
// prosciutto/pepperoni/salami), hidden animal-derived additives (rennet/
// suet/tallow/isinglass/carmine/marshmallow), and other mollusks/organs
// (squid/octopus/snail/escargot/foie gras/liver/tripe) already covered
// for allergy purposes via SHELLFISH_SYNONYMS but not diet-compliance.
const NON_VEGETARIAN_KEYWORDS = [
  "chicken", "beef", "pork", "bacon", "ham", "sausage", "turkey", "lamb", "duck", "veal", "venison",
  "goat", "rabbit", "bison", "quail", "chorizo", "prosciutto", "pepperoni", "salami",
  "gelatin", "gelatine", "lard", "rennet", "suet", "tallow", "isinglass", "carmine", "marshmallow",
  "foie gras", "liver", "tripe", "oyster sauce",
  ...FISH_SYNONYMS,
  ...SHELLFISH_SYNONYMS,
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

// Word-boundary match, not a bare substring check -- found live July 15
// 2026 while investigating a real recipe-search diet-compliance gap
// (Spoonacular's own diet=vegetarian/vegan tag can be wrong on a real
// recipe). A naive substring scan wrongly flagged "eggplant"/"veggie" for
// "egg", "coconut"/"butternut"/"peanut" for "nut", "buckwheat" for
// "wheat", and "nutmeg" for "nut" -- all single tokens that never equal
// the bare keyword, so \b...\b correctly leaves them alone. Allows an
// optional trailing "s" -- found while fixing this that several keyword
// lists rely on a singular stem ("cashew", "almond", "walnut") also
// matching its plain plural ("cashews", "almonds", "walnuts"), which
// strict word-boundary matching alone would have silently broken (a
// regression a first pass at this fix introduced and a test caught).
//
// Strips any trailing "s" off the needle BEFORE re-appending it as
// optional -- live-confirmed 2026-07-27: a free-text dislike typed as a
// plain plural ("mushrooms") only ever built the regex \bmushroomss?\b,
// which can never match a singular real-recipe occurrence like "cream of
// mushroom soup" (no trailing s at all). Stemming first makes the match
// symmetric regardless of which side is singular/plural, with no change
// for needles already singular (stemming a word with no trailing s is a
// no-op) and no change for the literal word itself when the needle
// happens to end in a non-plural "s" (e.g. "hummus" stems to "hummu",
// but "hummus?" still matches the real word "hummus" exactly as before).
function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const stem = needle.replace(/s$/i, "");
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}s?\\b`).test(haystack);
}

// Word-boundary alone doesn't cover genuine two-word compounds where the
// risky word IS its own separate token -- "coconut milk", "peanut
// butter", "almond cream" all have "milk"/"butter"/"cream" as a real,
// space-separated word, so \bmilk\b still matches. These three are the
// only keywords with a common plant-based compound form; a word like
// "chicken" or "shrimp" has no equivalent safe compound, so this
// exception list is deliberately short and specific, not a general
// escape hatch.
const PLANT_MODIFIERS = [
  "coconut", "almond", "oat", "soy", "soya", "cashew", "rice", "hemp",
  "peanut", "sunflower seed", "sunflower", "macadamia", "pea",
];
const COMPOUND_SAFE_WORDS = ["milk", "butter", "cream"];

// Audit item #2 (2026-07-21 spec): only checked the natural "coconut
// milk" word order -- a USDA-style comma-reordered name like "milk,
// coconut" (same phrasing pattern as commaSwapFallback in spoonacular.ts
// exists to fix) fell through this check entirely and got wrongly
// flagged as containing dairy. Reuses commaSwapFallback rather than
// re-deriving a second reorder implementation, so the two stay in sync
// by construction. This is an over-block fix, not a safety one: a false
// negative here can only make a genuinely-safe plant ingredient look
// unsafe, never the reverse.
function hasSafePlantCompound(haystack: string, word: string): boolean {
  if (!COMPOUND_SAFE_WORDS.includes(word)) return false;
  if (PLANT_MODIFIERS.some((mod) => wordBoundaryIncludes(haystack, `${mod} ${word}`))) return true;
  const reordered = commaSwapFallback(haystack);
  return reordered !== null && PLANT_MODIFIERS.some((mod) => wordBoundaryIncludes(reordered, `${mod} ${word}`));
}

// Live-confirmed (2026-07-21, stacked-safety investigation): "gluten-free
// rolled oats" and "rolled oats (gluten-free)" both got flagged unsafe for
// a gluten_free profile -- the bare word-boundary match for "gluten"
// fires on the literal word inside the ingredient's OWN "gluten-free"
// qualifier, punishing exactly the case where Claude correctly called out
// that an otherwise-risky ingredient (oats are commonly cross-
// contaminated) has been screened. Narrowly scoped to the literal word
// "gluten" immediately negated by "-free"/" free" in the SAME name --
// does NOT exempt any other GLUTEN_SYNONYMS word (wheat/bread/seitan/
// etc.), so an actually-contradictory label like "gluten-free seitan"
// still correctly flags (seitan is inherently wheat gluten regardless of
// how it's labeled). Same over-block-only reasoning as
// hasSafePlantCompound above: a false negative here can only make a
// genuinely gluten-free ingredient look unsafe, never the reverse.
function hasGlutenFreeQualifier(haystack: string, word: string): boolean {
  return word === "gluten" && /\bgluten[-\s]free\b/.test(haystack);
}

function containsAny(haystack: string, needles: string[]): string | null {
  return (
    needles.find(
      (n) => wordBoundaryIncludes(haystack, n) && !hasSafePlantCompound(haystack, n) && !hasGlutenFreeQualifier(haystack, n),
    ) ?? null
  );
}

// Returns a human-readable reason the ingredient is unsafe/should be
// excluded, or null if it passes every check this module knows about.
// null does NOT mean "verified safe" in an absolute sense -- it means
// "nothing here flagged it," same caveat as any keyword-based check.
export function isOpenEndedIngredientUnsafeFor(ingredientName: string, ctx: DietaryContext): string | null {
  const name = normalize(ingredientName);
  const allergyWords = ctx.allergies.map(normalize).filter(Boolean);
  const dislikeWords = ctx.dislikes.map(normalize).filter(Boolean);
  const userWords = [...allergyWords, ...dislikeWords];
  const intolerances = resolveIntolerances(ctx.dietaryStyles).map(normalize);

  for (const word of userWords) {
    if (wordBoundaryIncludes(name, word)) {
      return `matches excluded term "${word}"`;
    }
  }

  // Category-wide expansion (below) is deliberately allergy/dietary-style
  // ONLY, never dislikes -- found live July 20 2026 (dimension-5 dislike
  // stress test): a free-text DISLIKE of "blue cheese" word-boundary-
  // matched "cheese" in DAIRY_SYNONYMS and silently excluded the entire
  // dairy category (yogurt/milk/cream/butter too), starving 3 breakfast
  // slots that had nothing to do with blue cheese. A dislike is a soft,
  // single-item preference -- it only ever earns the direct name match
  // above, never a category-wide exclusion, which is reserved for real
  // allergies/dietary styles where over-blocking is the safe default.
  for (const group of SYNONYM_GROUPS) {
    // Word-boundary match, not bare array membership -- found live July 16
    // 2026 (comprehensive engine test). The old `group.words.includes(w)`
    // required the user's ENTIRE free-text word to be byte-for-byte equal
    // to a bare keyword like "shellfish", so a completely natural phrasing
    // like "shellfish allergy" or "peanut allergy" never activated ANY
    // category -- the single highest-severity finding of that test, since
    // it silently disabled every synonym group (nut/dairy/soy/fish/sesame/
    // egg/gluten) for anyone who didn't type the bare keyword alone.
    // Also excludes the same plant-compound false positives as the
    // ingredient-name check below -- found while implementing this fix:
    // without it, a user typing "peanut butter" or "coconut milk" as
    // their literal allergy/dislike text would ALSO trigger the DAIRY
    // category (since "butter"/"milk" are dairy synonyms), needlessly
    // excluding real dairy-free items like "greek yogurt" for someone
    // with no actual dairy restriction. Same COMPOUND_SAFE_WORDS/
    // PLANT_MODIFIERS exception, just applied to the user's own word
    // instead of the ingredient name.
    const userMentionedThisCategory =
      allergyWords.some((w) => group.words.some((gw) => wordBoundaryIncludes(w, gw) && !hasSafePlantCompound(w, gw))) ||
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
