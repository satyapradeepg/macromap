// LLM-based ingredient-identity classifier for grocery-list DISPLAY
// merging -- the display-side counterpart to identityMatch.ts, which only
// fixes pantry SUBTRACTION math. aggregate.ts groups grocery lines
// strictly by Spoonacular ingredient id; real plans routinely resolve the
// SAME real ingredient to several DIFFERENT ids across different recipes
// (live-confirmed 2026-07-25: one plan's "onion" split across ids 11282,
// 10011282, 10511282), so today those show as separate lines even though
// pantry math already pools correctly across them. This module decides
// whether two grocery-line NAMES refer to the same purchasable item, so
// groceryData.ts can canonicalize their ids to one before aggregate.ts
// ever groups anything -- aggregate.ts itself is never modified.
//
// Cached GLOBALLY (ingredient_line_identity_matches, migration 0024), not
// per user or per plan -- same reasoning as identityMatch.ts's cache.
//
// Safety note (found during design review, not the original naive idea):
// naive transitive closure over pairwise matches is NOT safe here. If
// A="chicken broth", B="broth", C="vegetable broth", both A-B and B-C
// could be legitimately confirmed against the hub "broth" while A-C would
// almost certainly be rejected if asked directly -- plain union-find would
// still merge all three, silently combining two different real products'
// quantities into one line. So a multi-name component only merges when
// it's a FULL CLIQUE in the confirmed-match graph (every pair
// independently confirmed), never just spanning-tree-connected. For the
// common 2-name case this is no different from a single pairwise check.

import { createAdminClient } from "@/lib/supabase/admin";

// Same tier/reasoning as identityMatch.ts's MODEL constant -- cheap
// classification, can run several times per plan.
const MODEL = "claude-haiku-4-5-20251001";

export interface IdentityEntry {
  id: number;
  name: string;
}

function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

// Spoonacular's own extendedIngredients[].id can be a non-positive
// placeholder for an ingredient it couldn't resolve at all (confirmed live
// 2026-07-25, aggregate.ts's isValidIngredientId) -- not unique per
// unresolved ingredient, so it must never participate in identity
// clustering. Kept as a local copy rather than imported from aggregate.ts,
// matching this codebase's established per-file-duplication convention
// for small helpers (see aggregate.ts's own comment on wordBoundaryIncludes).
function isValidIngredientId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

// Local copy of aggregate.ts's word-boundary overlap check -- decides only
// what's worth ASKING the LLM about (a cheap, local, no-network filter),
// never a merge decision by itself.
function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}s?\\b`).test(haystack);
}

// Grocery-duplicates investigation, 2026-07-31: whole-phrase containment
// above catches a dropped/added QUALIFIER at the front (e.g. "broccoli" ->
// "broccoli florets"), but not two names that share their LAST word (the
// real head noun) with a DIFFERENT leading modifier -- "bell pepper" and
// "red pepper" never share a substring relationship either direction, so
// they never became identity-match candidates at all (confirmed live: zero
// rows for this exact pair in ingredient_line_identity_matches, a pure
// candidate-generation gap, not a wrong cached answer). Requires BOTH
// names to have 2+ words -- a single-word name sharing the other's last
// word is already caught by wordBoundaryIncludes above (e.g. "pepper"
// alone is already contained in "bell pepper"), so this only ever adds the
// genuinely new case. Same "cheap, local, no-network filter" role as
// namesOverlap -- widening what's worth ASKING never changes what merges;
// isFullClique's own LLM-confirmed judgment still decides that.
function sharesLastWord(a: string, b: string): boolean {
  const wordsA = a.trim().split(/\s+/);
  const wordsB = b.trim().split(/\s+/);
  if (wordsA.length < 2 || wordsB.length < 2) return false;
  return wordsA[wordsA.length - 1] === wordsB[wordsB.length - 1];
}

function namesOverlap(a: string, b: string): boolean {
  return wordBoundaryIncludes(a, b) || wordBoundaryIncludes(b, a) || sharesLastWord(a, b);
}

function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function pairKey(a: string, b: string): string {
  const [x, y] = orderPair(a, b);
  return `${x}||${y}`;
}

export interface NameComponents {
  // Every distinct normalized name seen, mapped to every raw id that
  // shared that EXACT name -- these always merge for free, no LLM call
  // needed (identical text is as confident as identity gets).
  namesToIds: Map<string, Set<number>>;
  // Connected components (via namesOverlap) spanning 2+ DIFFERENT distinct
  // names -- each one needs LLM confirmation before it can merge.
  componentsNeedingConfirmation: string[][];
}

// Pure, no network -- exported for direct unit testing (this codebase's
// established convention: test the pure logic, not the network wrapper
// around it; see identityMatch.ts's parseMatchResponse).
export function buildNameComponents(entries: IdentityEntry[]): NameComponents {
  const namesToIds = new Map<string, Set<number>>();
  for (const entry of entries) {
    if (!isValidIngredientId(entry.id)) continue;
    const name = normalizeName(entry.name);
    const existing = namesToIds.get(name);
    if (existing) existing.add(entry.id);
    else namesToIds.set(name, new Set([entry.id]));
  }

  const distinctNames = [...namesToIds.keys()];

  // Union-find over distinct names, edges = namesOverlap. This only finds
  // candidate NEIGHBORHOODS worth investigating -- the clique check in
  // isFullClique (applied after live LLM confirmation) is what actually
  // decides whether a component is safe to merge.
  const parent = new Map<string, string>();
  for (const name of distinctNames) parent.set(name, name);
  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (let i = 0; i < distinctNames.length; i++) {
    for (let j = i + 1; j < distinctNames.length; j++) {
      if (namesOverlap(distinctNames[i], distinctNames[j])) {
        union(distinctNames[i], distinctNames[j]);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const name of distinctNames) {
    const root = find(name);
    const existing = groups.get(root);
    if (existing) existing.push(name);
    else groups.set(root, [name]);
  }

  return {
    namesToIds,
    componentsNeedingConfirmation: [...groups.values()].filter((g) => g.length > 1),
  };
}

// Exported, pure -- true only when EVERY pair within `names` is present in
// `confirmedMatchKeys` (order-independent). A component that's merely
// connected but not a full clique is left entirely unmerged (see the
// "chicken broth / broth / vegetable broth" hub-bridge risk in the header
// comment) -- no partial-clique splitting in this pass.
export function isFullClique(names: string[], confirmedMatchKeys: Set<string>): boolean {
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (!confirmedMatchKeys.has(pairKey(names[i], names[j]))) return false;
    }
  }
  return true;
}

// Exported, pure -- generalizes isFullClique so ONE non-matching pair
// doesn't poison an entire candidate component (live-confirmed 2026-07-31:
// a real plan's "chicken"/"chicken breast"/"chicken breasts"/"cooked
// chicken breast"/"chicken breast halves boned and skinned" component
// failed to merge AT ALL, even though "chicken breast"/"chicken breasts"/
// "...boned and skinned" are obviously the same raw product -- "cooked
// chicken breast" is correctly rejected as a genuinely different physical
// quantity (cooking drives off moisture; this codebase has no raw<->cooked
// yield-factor conversion anywhere), and under the old all-or-nothing gate
// that one correct rejection blocked the other three from merging too).
//
// Finds every maximal clique (size >= 2) in the confirmed-match graph via
// Bron-Kerbosch (components here are always tiny -- a handful of names --
// so no pivoting/optimization is needed), then excludes any name that
// belongs to MORE than one maximal clique. Such a name is an ambiguous
// hub (this module's own "chicken broth"/"broth"/"vegetable broth" risk,
// tested below) -- which of its candidate groups it "really" belongs to is
// exactly the judgment isFullClique was designed to refuse to make, so it's
// left out of every group rather than arbitrarily assigned to one. A
// clique that drops below 2 members after hub-exclusion contributes no
// merge at all, matching the original safe default.
export function partitionConfirmedCliques(names: string[], confirmedMatchKeys: Set<string>): string[][] {
  const n = names.length;
  const adjacent = (i: number, j: number) => confirmedMatchKeys.has(pairKey(names[i], names[j]));

  const maximalCliques: number[][] = [];
  function bronKerbosch(r: number[], p: number[], x: number[]) {
    if (p.length === 0 && x.length === 0) {
      if (r.length >= 2) maximalCliques.push(r);
      return;
    }
    let remainingP = [...p];
    const seenX = [...x];
    for (const v of [...remainingP]) {
      bronKerbosch(
        [...r, v],
        remainingP.filter((i) => adjacent(v, i)),
        seenX.filter((i) => adjacent(v, i)),
      );
      remainingP = remainingP.filter((i) => i !== v);
      seenX.push(v);
    }
  }
  bronKerbosch(
    [],
    Array.from({ length: n }, (_, i) => i),
    [],
  );

  const membershipCount = new Map<number, number>();
  for (const clique of maximalCliques) {
    for (const i of clique) membershipCount.set(i, (membershipCount.get(i) ?? 0) + 1);
  }

  const result: string[][] = [];
  for (const clique of maximalCliques) {
    const unambiguous = clique.filter((i) => membershipCount.get(i) === 1);
    if (unambiguous.length >= 2) result.push(unambiguous.map((i) => names[i]));
  }
  return result;
}

// Exported, pure -- builds the final id -> canonical-id map from a
// NameComponents result plus the caller-resolved list of components that
// passed the full-clique check. Canonical id per merging group is its
// LOWEST raw id (arbitrary but deterministic) -- the specific numeric
// choice doesn't matter downstream since buildGroceryLines/mergeConvertibleLines
// only care that every entry in a real-identity group shares ONE id; which
// entry's NAME wins for display was already an existing, unrelated
// "whichever comes first in iteration order" behavior before this feature.
export function buildIdRemap(namesToIds: Map<string, Set<number>>, qualifyingComponents: string[][]): Map<number, number> {
  const remap = new Map<number, number>();

  for (const ids of namesToIds.values()) {
    for (const id of ids) remap.set(id, id);
  }

  // Exact-same-name groups merge unconditionally -- identical text is
  // already maximal-confidence identity, no LLM confirmation needed.
  for (const ids of namesToIds.values()) {
    if (ids.size <= 1) continue;
    const canonical = Math.min(...ids);
    for (const id of ids) remap.set(id, canonical);
  }

  // Clique-confirmed multi-name components fold their ids in on top.
  for (const names of qualifyingComponents) {
    const allIds = new Set<number>();
    for (const name of names) {
      for (const id of namesToIds.get(name) ?? []) allIds.add(id);
    }
    if (allIds.size === 0) continue;
    const canonical = Math.min(...allIds);
    for (const id of allIds) remap.set(id, canonical);
  }

  return remap;
}

const MATCH_LINE_TOOL = {
  name: "match_grocery_line_identity",
  description:
    "Decide which grocery-list ingredient names refer to the SAME purchasable grocery item as another grocery-list ingredient name.",
  input_schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        description:
          "The subset of the candidate names (verbatim) that refer to the same purchasable grocery item as the anchor name -- these should be combined into one grocery-list line instead of listed separately.",
        items: { type: "string" },
      },
    },
    required: ["matches"],
  },
};

// The specific "NOT matching" categories below were added 2026-07-31 after
// auditing ~750 real cached names/judgments and finding this exact class of
// wrong merge already confirmed live: "cooked rice" <-> "rice", "chicken
// bouillon cubes" <-> "chicken broth"/"chicken stock", "beans" <-> "canned
// kidney beans" -- the earlier prompt's one example ("chicken broth" is not
// "chicken breast") only demonstrated a different-CORE-ingredient mismatch,
// nothing hinting at the different-QUANTITY-of-the-SAME-core-ingredient
// risk, which is a distinct failure mode a smaller model needs spelled out
// rather than inferred.
function buildPrompt(anchorName: string, candidates: string[]): string {
  return `A grocery list has an ingredient line named "${anchorName}". Which of the following OTHER grocery-list ingredient names refer to the SAME purchasable grocery item, such that they should be combined into one line instead of listed separately?

Candidates:
${candidates.map((c) => `- ${c}`).join("\n")}

Treat differently-prepared or differently-labeled variants of a genuinely different product as NOT matching -- for example, "green onions" and "onion" are different produce items sold separately, and "chicken broth" is not the same purchase as "vegetable broth" or "chicken breast". Only include a candidate if a grocery store would reasonably shelve it as the same item as the anchor (matching on the core ingredient; minor descriptor differences like brand, "large", or "organic" are fine).

Also treat these as NOT matching even when the core ingredient word is identical, because the two names imply meaningfully different real-world QUANTITIES of that ingredient (cooking, drying, and concentrating all change weight/volume, sometimes drastically) -- combining their amounts into one line would silently misstate how much to actually buy:
- Raw vs. cooked/prepared (e.g. "rice" vs. "cooked rice"; "chicken breast" vs. "cooked chicken breast" or a marinated-raw variant)
- Dried vs. fresh produce or herbs (e.g. "thyme" vs. "dried thyme")
- Canned/hydrated vs. dry (e.g. "beans" vs. "canned kidney beans")
- A concentrated or dry form vs. its diluted/liquid form (e.g. "chicken bouillon cubes" vs. "chicken broth" or "chicken stock")
- A generic/whole-item name vs. a specific cut or variety of it (e.g. "chicken" vs. "chicken breast"; "beans" vs. a specific bean variety) -- these are different purchasable products even when one word is a literal substring of the other.

When genuinely unsure, leave it out -- a missed match just leaves one redundant line on the list, which is safer than wrongly combining two different products' (or two different quantities of the same product's) amounts into one.`;
}

// Never trusts the LLM's JSON shape blindly, and never trusts it to only
// echo real candidates verbatim -- same discipline as identityMatch.ts's
// parseMatchResponse. Exported (pure, no network) for direct unit testing.
export function parseLineMatchResponse(raw: unknown, candidates: string[]): Set<string> | null {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).matches)) {
    return null;
  }
  const candidateSet = new Set(candidates.map(normalizeName));
  const matches = (raw as { matches: unknown[] }).matches.filter((m): m is string => typeof m === "string");
  return new Set(matches.map(normalizeName).filter((m) => candidateSet.has(m)));
}

async function classifyLineMatches(anchorName: string, candidates: string[]): Promise<Set<string> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        tools: [MATCH_LINE_TOOL],
        tool_choice: { type: "tool", name: "match_grocery_line_identity" },
        messages: [{ role: "user", content: buildPrompt(anchorName, candidates) }],
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const body = await response.json();
  const toolUse = (body.content ?? []).find((block: { type: string }) => block.type === "tool_use");
  if (!toolUse) return null;

  return parseLineMatchResponse(toolUse.input, candidates);
}

// Resolves every pairwise judgment a component needs (cache first, LLM for
// the rest), batched by anchor name so a component of k names costs at
// most k LLM calls, not k*(k-1)/2 -- same batching shape as
// identityMatch.ts's resolveIdentityMatches. Returns the set of CONFIRMED
// MATCH pair-keys only; isFullClique then decides if that's everything the
// component needs.
async function resolveComponentConfirmedPairs(names: string[]): Promise<Set<string>> {
  const confirmed = new Set<string>();
  if (names.length < 2) return confirmed;

  const admin = createAdminClient();

  const allPairs: Array<[string, string]> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      allPairs.push(orderPair(names[i], names[j]));
    }
  }

  const { data: cached } = await admin
    .from("ingredient_line_identity_matches")
    .select("name_a, name_b, is_match")
    .in("name_a", names)
    .in("name_b", names);

  const cachedByKey = new Map<string, boolean>();
  for (const row of cached ?? []) {
    cachedByKey.set(`${row.name_a}||${row.name_b}`, row.is_match);
  }

  for (const [a, b] of allPairs) {
    if (cachedByKey.get(`${a}||${b}`)) confirmed.add(`${a}||${b}`);
  }

  const uncachedPairs = allPairs.filter(([a, b]) => !cachedByKey.has(`${a}||${b}`));
  if (uncachedPairs.length === 0) return confirmed;

  const uncachedByAnchor = new Map<string, string[]>();
  for (const [a, b] of uncachedPairs) {
    const list = uncachedByAnchor.get(a);
    if (list) list.push(b);
    else uncachedByAnchor.set(a, [b]);
  }

  const newRows: Array<{ name_a: string; name_b: string; is_match: boolean }> = [];
  await Promise.all(
    [...uncachedByAnchor.entries()].map(async ([anchor, candidates]) => {
      const matches = await classifyLineMatches(anchor, candidates);
      // Transient failure -- leave these pairs unresolved this time rather
      // than caching either outcome, same "never calcify a wrong answer
      // from an API error" precedent as identityMatch.ts.
      if (!matches) return;
      for (const candidate of candidates) {
        const isMatch = matches.has(normalizeName(candidate));
        newRows.push({ name_a: anchor, name_b: candidate, is_match: isMatch });
        if (isMatch) confirmed.add(`${anchor}||${candidate}`);
      }
    }),
  );

  if (newRows.length > 0) {
    await admin.from("ingredient_line_identity_matches").upsert(newRows, { onConflict: "name_a,name_b" });
  }

  return confirmed;
}

// Top-level entry point for groceryData.ts: given every raw {id, name}
// entry from a plan's slot ingredients + addons, returns a map from every
// raw id to its canonical id (identity-mapped for ids that don't merge
// with anything). Apply this to slot/addon ids AND to pantry items'
// spoonacular_ingredient_id (see groceryData.ts wiring) BEFORE calling
// aggregate.ts's buildGroceryLines -- aggregate.ts itself never changes.
export async function resolveLineIdentityRemap(entries: IdentityEntry[]): Promise<Map<number, number>> {
  const { namesToIds, componentsNeedingConfirmation } = buildNameComponents(entries);

  const qualifyingComponents: string[][] = [];
  await Promise.all(
    componentsNeedingConfirmation.map(async (names) => {
      const confirmed = await resolveComponentConfirmedPairs(names);
      qualifyingComponents.push(...partitionConfirmedCliques(names, confirmed));
    }),
  );

  return buildIdRemap(namesToIds, qualifyingComponents);
}
