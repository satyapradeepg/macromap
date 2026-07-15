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

const DAIRY_SYNONYMS = ["dairy", "milk", "lactose"];
const NUT_SYNONYMS = ["nut", "nuts", "peanut", "peanuts", "tree nut", "tree nuts"];
const SOY_SYNONYMS = ["soy", "soya"];

function mentionsAny(words: string[], synonyms: string[]): boolean {
  return words.some((word) => {
    const normalized = word.toLowerCase().trim();
    return normalized.length > 0 && synonyms.some((syn) => normalized === syn || normalized.includes(syn));
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
    if (normalized.length > 0 && ingredientKey.toLowerCase().includes(normalized)) {
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
  if (entry.containsGluten && intolerances.includes("gluten")) {
    return "contains gluten (gluten-free diet)";
  }

  if (!entry.veganCompliant && ctx.dietaryStyles.includes("vegan")) {
    return "not vegan-compliant";
  }

  return null;
}

export function filterSafeIngredientNames(names: string[], ctx: DietaryContext): string[] {
  return names.filter((name) => isKnownIngredientUnsafeFor(name, ctx) === null);
}
