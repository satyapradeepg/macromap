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

// Live-confirmed 2026-07-31 (persona audit): a "halal" profile got pork
// (ham hocks, salt pork) and white wine served across a real generated
// week -- neither halal nor kosher had ANY keyword coverage anywhere in
// this codebase; the word "pork" existed only inside NON_VEGETARIAN_
// KEYWORDS above, which is never consulted for a halal/kosher profile.
// This is a deliberately narrow, CHECKABLE subset of each religious
// dietary law -- pork and alcohol for halal, pork and shellfish for
// kosher -- not a certified/zabiha-verified guarantee (slaughter method
// can't be verified from ingredient text at all, and kosher's meat/dairy
// separation rule is a per-DISH cross-ingredient check, structurally
// different from everything else in this file, and deliberately left
// out: too much real ambiguity -- chicken broth in a cream sauce? a
// "non-dairy" creamer? -- for a keyword scan to resolve safely).
const PORK_SYNONYMS = [
  "pork", "bacon", "ham", "ham hock", "ham hocks", "salt pork", "prosciutto", "pepperoni",
  "salami", "chorizo", "lard", "pancetta", "guanciale", "spam",
];
// Zero coverage anywhere in this codebase before this -- confirmed via
// grep. Common cooking-wine forms included since they're still real wine.
const ALCOHOL_SYNONYMS = [
  "wine", "beer", "rum", "whiskey", "whisky", "bourbon", "vodka", "brandy", "sherry", "sake",
  "liqueur", "marsala", "mirin", "champagne", "cognac", "kirsch", "amaretto", "vermouth",
  "triple sec", "schnapps",
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

// Mirror of hasSafePlantCompound above, roles reversed: there the RISKY
// word was a dairy product name and the exception looked for a PLANT
// modifier in front of it ("coconut milk"). Here the risky word is an
// ANIMAL name from NON_VEGETARIAN_KEYWORDS ("goat") and the exception
// looks for a DAIRY PRODUCT word next to it ("goat cheese") -- goat is
// the one NON_VEGETARIAN_KEYWORDS entry that's also a completely normal
// dairy-source name, the same false-positive shape as "coconut milk"
// wrongly tripping DAIRY_SYNONYMS' "milk". Live-confirmed 2026-07-27
// against a real ~640-recipe Spoonacular sample: 15 genuinely vegetarian
// "goat cheese" recipes would all have been wrongly excluded without
// this -- a pre-existing gap, not introduced by the title check below,
// found while validating it.
const ANIMAL_DAIRY_SOURCE_WORDS = ["goat"];
const DAIRY_PRODUCT_WORDS = ["cheese", "milk", "yogurt", "yoghurt", "butter", "curd", "feta"];

function hasAnimalDairySourceCompound(haystack: string, word: string): boolean {
  if (!ANIMAL_DAIRY_SOURCE_WORDS.includes(word)) return false;
  if (DAIRY_PRODUCT_WORDS.some((dw) => wordBoundaryIncludes(haystack, `${word} ${dw}`))) return true;
  const reordered = commaSwapFallback(haystack);
  return reordered !== null && DAIRY_PRODUCT_WORDS.some((dw) => wordBoundaryIncludes(reordered, `${word} ${dw}`));
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

// Mirror of hasSafePlantCompound's shape: a handful of common ingredient
// names contain an ALCOHOL_SYNONYMS word as a real, space-separated
// substring but carry no meaningful alcohol themselves -- "wine vinegar"
// is vinegar (fermentation converts the alcohol away, none remains in the
// product), and "root beer"/"ginger beer" are ordinary non-alcoholic
// sodas despite the name. Deliberately short and specific, same
// philosophy as PLANT_MODIFIERS -- add to this list only when a real
// collision is confirmed, not speculatively.
const SAFE_ALCOHOL_COMPOUNDS = ["wine vinegar", "root beer", "ginger beer"];

function hasSafeAlcoholCompound(haystack: string, word: string): boolean {
  if (word !== "wine" && word !== "beer") return false;
  return SAFE_ALCOHOL_COMPOUNDS.some((c) => wordBoundaryIncludes(haystack, c));
}

function containsAny(haystack: string, needles: string[]): string | null {
  return (
    needles.find(
      (n) =>
        wordBoundaryIncludes(haystack, n) &&
        !hasSafePlantCompound(haystack, n) &&
        !hasGlutenFreeQualifier(haystack, n) &&
        !hasAnimalDairySourceCompound(haystack, n) &&
        !hasSafeAlcoholCompound(haystack, n),
    ) ?? null
  );
}

// Shared by isOpenEndedIngredientUnsafeFor and isRecipeTitleUnsafeFor below
// so the vegan/vegetarian branch stays in exactly one place -- extracted
// 2026-07-27 when the title check was added, no behavior change for the
// ingredient-name path.
function vegetarianOrVeganViolation(name: string, dietaryStyles: string[]): string | null {
  if (dietaryStyles.includes("vegan")) {
    return containsAny(name, NON_VEGAN_EXTRA_KEYWORDS);
  } else if (dietaryStyles.includes("vegetarian")) {
    return containsAny(name, NON_VEGETARIAN_KEYWORDS);
  }
  return null;
}

// Checkable subset only -- see the PORK_SYNONYMS/ALCOHOL_SYNONYMS comment
// above for what's deliberately out of scope (slaughter method, kosher
// meat/dairy separation).
function halalViolation(name: string, dietaryStyles: string[]): string | null {
  if (!dietaryStyles.includes("halal")) return null;
  return containsAny(name, [...PORK_SYNONYMS, ...ALCOHOL_SYNONYMS]);
}

function kosherViolation(name: string, dietaryStyles: string[]): string | null {
  if (!dietaryStyles.includes("kosher")) return null;
  return containsAny(name, [...PORK_SYNONYMS, ...SHELLFISH_SYNONYMS]);
}

// Returns a human-readable reason the ingredient is unsafe/should be
// excluded, or null if it passes every check this module knows about.
// null does NOT mean "verified safe" in an absolute sense -- it means
// "nothing here flagged it," same caveat as any keyword-based check.
// Shared by isOpenEndedIngredientUnsafeFor's category loop below and
// condimentRiskWarnings further down (extracted 2026-07-31 when the
// latter was added) -- "does this profile's allergies/dietary styles
// activate this synonym group at all," same word-boundary-and-plant-
// modifier-aware check either caller needs.
function userMentionsCategory(ctx: DietaryContext, group: { words: string[]; dietaryIntolerance?: string }): boolean {
  const allergyWords = ctx.allergies.map(normalize).filter(Boolean);
  const intolerances = resolveIntolerances(ctx.dietaryStyles).map(normalize);
  return (
    allergyWords.some((w) => group.words.some((gw) => wordBoundaryIncludes(w, gw) && !hasSafePlantCompound(w, gw))) ||
    (group.dietaryIntolerance !== undefined && intolerances.includes(group.dietaryIntolerance))
  );
}

export function isOpenEndedIngredientUnsafeFor(ingredientName: string, ctx: DietaryContext): string | null {
  const name = normalize(ingredientName);
  const allergyWords = ctx.allergies.map(normalize).filter(Boolean);
  const dislikeWords = ctx.dislikes.map(normalize).filter(Boolean);
  const userWords = [...allergyWords, ...dislikeWords];

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
    if (!userMentionsCategory(ctx, group)) continue;
    const hit = containsAny(name, group.alsoMatches);
    if (hit) {
      return `"${ingredientName}" contains "${hit}", matching an excluded category`;
    }
  }

  const dietHit = vegetarianOrVeganViolation(name, ctx.dietaryStyles);
  if (dietHit) {
    const style = ctx.dietaryStyles.includes("vegan") ? "vegan" : "vegetarian";
    return `"${ingredientName}" contains "${dietHit}", not ${style}-compliant`;
  }

  const halalHit = halalViolation(name, ctx.dietaryStyles);
  if (halalHit) {
    return `"${ingredientName}" contains "${halalHit}", not halal-compliant`;
  }

  const kosherHit = kosherViolation(name, ctx.dietaryStyles);
  if (kosherHit) {
    return `"${ingredientName}" contains "${kosherHit}", not kosher-compliant`;
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

// Real recipe titles routinely brand a genuinely plant-based dish with a
// meat-analogue word ("Vegan Chicken Nuggets," "Meatless Bacon BLT") --
// live-searched Spoonacular's actual corpus 2026-07-27 and found none of
// that branding pattern discoverable there at all ("vegan chicken",
// "meatless bacon", "vegan ham", "tempeh bacon", etc. every one returned
// zero results), so this exemption is cheap insurance against a pattern
// that may simply be rare in this specific corpus, not proof it never
// occurs. A qualifier ANYWHERE in the (short) title exempts the whole
// title, not just an adjacent-word pairing -- simpler than pairing each
// keyword with a qualifier immediately next to it, and titles are short
// enough that an unrelated qualifier elsewhere in the same title is a
// low-probability coincidence.
const MEAT_ANALOGUE_QUALIFIERS = [
  "vegan", "vegetarian", "meatless", "plant-based", "plant based", "veggie", "mock", "faux", "meat-free", "meat free",
];

// A handful of real plant/fungus species share a name with meat --
// "chicken of the woods" is a genuine, common edible mushroom, no
// relation to poultry. Deliberately short and specific, same philosophy
// as PLANT_MODIFIERS above -- add to this list only when a real
// collision is confirmed, not speculatively.
const MEAT_NAMED_PLANT_FOODS = ["chicken of the woods", "hen of the woods"];

// Deterministic backstop for a real, live-confirmed gap (2026-07-27): the
// ingredient-name check above only ever sees Spoonacular's OWN structured
// ingredient list, which can be incomplete relative to what a recipe's
// title implies -- live-confirmed on a real recipe titled "Ham and Swiss
// Panini With Mushrooms and Kale" whose actual extendedIngredients never
// mentioned ham at all (bread, cheese, mushroom, kale, thyme, mustard),
// so the ingredient check alone passed a genuine vegetarian violation.
// Same live sample also found "Broccoli Rabe and Breaded Veal Scallopini"
// and "Mussels & Clams in White Wine" both similarly mistagged vegetarian
// by Spoonacular with the meat/shellfish absent from their own ingredient
// data -- not a one-off, a real recurring gap in Spoonacular's own data
// quality. This check is titles-only; it does not replace
// anyIngredientUnsafeFor above, it closes what that check structurally
// cannot see.
export function isRecipeTitleUnsafeFor(title: string, ctx: DietaryContext): string | null {
  const name = normalize(title);
  if (MEAT_NAMED_PLANT_FOODS.some((food) => name.includes(food))) return null;
  if (MEAT_ANALOGUE_QUALIFIERS.some((q) => wordBoundaryIncludes(name, q))) return null;

  const dietHit = vegetarianOrVeganViolation(name, ctx.dietaryStyles);
  if (dietHit) {
    const style = ctx.dietaryStyles.includes("vegan") ? "vegan" : "vegetarian";
    return `title "${title}" contains "${dietHit}", not ${style}-compliant`;
  }

  const halalHit = halalViolation(name, ctx.dietaryStyles);
  if (halalHit) {
    return `title "${title}" contains "${halalHit}", not halal-compliant`;
  }

  const kosherHit = kosherViolation(name, ctx.dietaryStyles);
  if (kosherHit) {
    return `title "${title}" contains "${kosherHit}", not kosher-compliant`;
  }

  return null;
}

// Exported for orchestrate.ts's excludeIngredients construction -- merges
// pork/alcohol/shellfish keywords into the SAME free-text-exclusion list a
// user's own allergies/dislikes already flow through (see orchestrate.ts's
// excludeIngredients), so Spoonacular's own search also avoids obviously-
// tagged candidates. Deliberately reuses these exact lists rather than a
// second hand-maintained copy in dietaryMapping.ts, to avoid the two
// drifting out of sync (and dietaryMapping.ts importing this module would
// create a circular import, since this module already imports
// resolveIntolerances from dietaryMapping.ts).
export function dietaryStyleExcludeKeywords(dietaryStyles: string[]): string[] {
  const keywords = new Set<string>();
  if (dietaryStyles.includes("halal")) {
    for (const w of [...PORK_SYNONYMS, ...ALCOHOL_SYNONYMS]) keywords.add(w);
  }
  if (dietaryStyles.includes("kosher")) {
    for (const w of [...PORK_SYNONYMS, ...SHELLFISH_SYNONYMS]) keywords.add(w);
  }
  return [...keywords];
}

// Persona audit 2026-07-31, finding #3: mealProposer.ts's safeProteinExamples
// steers the "protein" role away from allergen-conflicting suggestions, but
// nothing does the same for the "fixed" role (0-2 small garnish/condiment
// items) -- a stacked-restriction profile whose blocked slots lean on one
// cuisine (e.g. seitan stir-fry/gyro/fajita for vegan+soy) can keep reaching
// for the exact condiment that's a natural flavoring for that cuisine (soy
// sauce/tamari/miso) with only the general constraint text + self-check to
// stop it -- the same "follows the concrete dish pattern over an abstract
// constraint" failure mode already fixed for the protein role. Advisory
// prompt-hinting only, same as safeProteinExamples -- the real gate remains
// isOpenEndedIngredientUnsafeFor above; this can only reduce how often that
// gate has to reject something, never substitute for it.
const CONDIMENT_RISKS: Array<{ label: string; appliesTo: (ctx: DietaryContext) => boolean }> = [
  { label: "soy sauce, tamari, or miso (contain soy)", appliesTo: (ctx) => userMentionsCategory(ctx, { words: SOY_SYNONYMS }) },
  { label: "honey (not vegan)", appliesTo: (ctx) => ctx.dietaryStyles.includes("vegan") },
  {
    label: "Worcestershire sauce, fish sauce, or oyster sauce (contain fish/shellfish)",
    appliesTo: (ctx) =>
      ctx.dietaryStyles.includes("vegan") ||
      ctx.dietaryStyles.includes("vegetarian") ||
      userMentionsCategory(ctx, { words: FISH_SYNONYMS }) ||
      userMentionsCategory(ctx, { words: SHELLFISH_SYNONYMS }),
  },
  {
    label: "mayonnaise, aioli, or hollandaise (contain egg)",
    appliesTo: (ctx) => ctx.dietaryStyles.includes("vegan") || userMentionsCategory(ctx, { words: EGG_SYNONYMS }),
  },
  {
    label: "butter, cream, or parmesan (contain dairy)",
    appliesTo: (ctx) => ctx.dietaryStyles.includes("vegan") || userMentionsCategory(ctx, { words: DAIRY_SYNONYMS, dietaryIntolerance: "dairy" }),
  },
];

export function condimentRiskWarnings(ctx: DietaryContext): string[] {
  return CONDIMENT_RISKS.filter((r) => r.appliesTo(ctx)).map((r) => r.label);
}
