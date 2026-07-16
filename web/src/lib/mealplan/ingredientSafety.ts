// Deterministic safety gate for the fixed-pool ingredient system
// (snackComposition.ts, addon.ts). Found and fixed July 15 2026: neither
// file had EVER checked a profile's allergies/dietary style/dislikes
// before this — a user with a nut allergy (a first-class F2 preset) could
// be served almonds/peanut butter/walnuts in a composed snack or add-on,
// and a vegan user could be served dairy. This is the hard backstop that
// makes that impossible, independent of anything upstream: fails closed
// (excludes on any doubt), never tries to "fix" a violation by silently
// swapping to something unverified.
//
// Three independent checks, since they catch different things:
// 1. Exact/substring match against the user's own allergy/dislike words —
//    same source of truth already used to build Spoonacular's
//    excludeIngredients param for recipe search, plus a small synonym
//    table (e.g. free-text "dairy"/"milk" doesn't literally appear in
//    "greek yogurt", so a bare substring check alone would miss it).
// 2. The static table's curated safety tags (staticIngredientMacros.ts) —
//    exact, not inferred, since this is a small fixed set we fully control.
// 3. Dietary-STYLE presets (dairy_free/gluten_free), added July 15 2026
//    (audit round 2) after live-testing found this gate never consulted
//    them at all — only free-text allergies/dislikes and a hardcoded
//    "vegan" check existed, so a dairy_free+gluten_free profile with no
//    vegan style could be (and was) served cottage cheese/greek yogurt in
//    a composed snack even though dietaryMapping.ts's resolveIntolerances
//    already correctly maps those same presets to Spoonacular's
//    intolerances param for the recipe-search side. Reuses
//    resolveIntolerances directly rather than re-deriving a second
//    preset->restriction mapping here, so the two stay in sync by
//    construction instead of by discipline.
//
// Scoped ONLY to the known static 9-ingredient pool. An ingredient name
// this module has never heard of returns null ("not flagged"), which is
// correct here (unknown names in this fixed system indicate a bug
// upstream, not a new food) but would be the WRONG default for an
// open-ended source (e.g. a future LLM-composed ingredient list) — that
// path needs a separately-designed, more conservative check that treats
// "unrecognized" as unsafe, not safe.

import { STATIC_INGREDIENT_MACROS } from "./staticIngredientMacros";
import { resolveIntolerances } from "./dietaryMapping";

export interface DietaryContext {
  dietaryStyles: string[];
  allergies: string[];
  dislikes: string[];
}

// Widened July 16 2026 (comprehensive engine test) to match the broader
// lists already validated in the sibling open-ended gate
// (openEndedIngredientSafety.ts) -- this file's own comment says
// protein powder is conservatively dairy-tagged specifically because it
// might be whey-based, but a "whey" allergy/dislike never matched it
// before this fix, since none of these derivative-form words were in
// these lists.
const DAIRY_SYNONYMS = [
  "dairy", "milk", "lactose", "cheese", "yogurt", "yoghurt", "cream", "butter", "whey",
  "ghee", "paneer", "kefir", "ricotta", "mascarpone", "casein", "gelato",
];
const NUT_SYNONYMS = ["nut", "nuts", "peanut", "peanuts", "tree nut", "tree nuts"];
const SOY_SYNONYMS = ["soy", "soya", "tofu", "edamame", "tempeh", "miso", "natto", "tamari", "soy lecithin", "tvp", "textured vegetable protein"];
// Added July 16 2026 (comprehensive engine test): this file previously
// only checked the gluten_free dietary-STYLE toggle for gluten, with no
// free-text allergy/dislike check at all -- a user who picks the "wheat"
// allergy preset chip (a real F2 option) but doesn't separately toggle
// gluten_free got zero protection here. Latent today only because no
// pool item has containsGluten: true, but this closes it before the pool
// grows, matching the file's own stated future-proofing intent.
const GLUTEN_SYNONYMS = ["gluten", "wheat", "malt", "semolina", "farro", "spelt", "bulgur", "panko", "udon", "orzo", "matzo"];

// Word-boundary match, not a bare substring check -- fixes the same bug
// class already fixed the same day in the sibling open-ended gate
// (openEndedIngredientSafety.ts). Live-confirmed (July 15 2026): a
// bare `normalized.includes(syn)` check meant a free-text dislike of
// "nutmeg" or "donut" contained the substring "nut" and incorrectly
// triggered the nut category. Allows an optional trailing "s" for the
// same plural-tolerance reason as the sibling file.
function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}s?\\b`).test(haystack);
}

// Same plant-compound exception as the sibling open-ended gate
// (openEndedIngredientSafety.ts) -- found while widening DAIRY_SYNONYMS
// above to include "butter"/"milk"/"cream" (July 16 2026, comprehensive
// engine test). Without this, a user typing "peanut butter" or "coconut
// milk" as their literal allergy/dislike text would ALSO trigger the
// dairy category (since "butter"/"milk" are dairy synonyms), needlessly
// excluding real dairy-containing-but-actually-fine-for-them pool items
// like greek yogurt/cottage cheese for someone with no real dairy
// restriction. Deliberately short and specific, not a general escape
// hatch -- mirrors the sibling file's own list exactly.
const PLANT_MODIFIERS = [
  "coconut", "almond", "oat", "soy", "soya", "cashew", "rice", "hemp",
  "peanut", "sunflower seed", "sunflower", "macadamia", "pea",
];
const COMPOUND_SAFE_WORDS = ["milk", "butter", "cream"];

function hasSafePlantCompound(haystack: string, word: string): boolean {
  if (!COMPOUND_SAFE_WORDS.includes(word)) return false;
  return PLANT_MODIFIERS.some((mod) => wordBoundaryIncludes(haystack, `${mod} ${word}`));
}

function mentionsAny(words: string[], synonyms: string[]): boolean {
  return words.some((word) => {
    const normalized = word.toLowerCase().trim();
    return (
      normalized.length > 0 &&
      synonyms.some((syn) => wordBoundaryIncludes(normalized, syn) && !hasSafePlantCompound(normalized, syn))
    );
  });
}

// Returns a human-readable reason if `ingredientKey` is unsafe for this
// profile, or null if it's a known ingredient that passes every check.
// Returns null (not an error) for a name outside the static table too —
// see the file header for why that default doesn't transfer to other
// callers.
export function isKnownIngredientUnsafeFor(ingredientKey: string, ctx: DietaryContext): string | null {
  const entry = STATIC_INGREDIENT_MACROS[ingredientKey.toLowerCase().trim()];
  if (!entry) return null;

  const userWords = [...ctx.allergies, ...ctx.dislikes];
  // Single source of truth also used by the recipe-search path
  // (dietaryMapping.ts) -- keeps dairy_free/gluten_free enforcement here
  // in sync with what Spoonacular's own intolerances param already
  // enforces, instead of a second hand-maintained preset list.
  const intolerances = resolveIntolerances(ctx.dietaryStyles).map((i) => i.toLowerCase());

  for (const word of userWords) {
    const normalized = word.toLowerCase().trim();
    if (normalized.length > 0 && wordBoundaryIncludes(ingredientKey.toLowerCase(), normalized)) {
      return `matches excluded term "${word}"`;
    }
  }

  if (entry.containsNut && mentionsAny(userWords, NUT_SYNONYMS)) {
    return "contains nuts (explicit allergy/dislike)";
  }
  if (entry.containsDairy && (mentionsAny(userWords, DAIRY_SYNONYMS) || intolerances.includes("dairy"))) {
    return "contains dairy (explicit allergy/dislike or dairy-free diet)";
  }
  if (entry.containsSoy && mentionsAny(userWords, SOY_SYNONYMS)) {
    return "contains soy (explicit allergy/dislike)";
  }
  if (entry.containsGluten && (mentionsAny(userWords, GLUTEN_SYNONYMS) || intolerances.includes("gluten"))) {
    return "contains gluten (explicit allergy/dislike or gluten-free diet)";
  }

  if (!entry.veganCompliant && ctx.dietaryStyles.includes("vegan")) {
    return "not vegan-compliant";
  }

  return null;
}

export function filterSafeIngredientNames(names: string[], ctx: DietaryContext): string[] {
  return names.filter((name) => isKnownIngredientUnsafeFor(name, ctx) === null);
}
