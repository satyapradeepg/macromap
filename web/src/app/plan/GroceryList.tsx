"use client";

// Epic E3 (F4): deduped list + quantities, grouped by aisle for a real
// shopping trip. No prices shown -- Satya's call (2026-08-08): grocery
// prices were too often unresolvable ("Price unavailable") to be useful,
// so this only ever shows names/amounts now.

import { useState } from "react";
import type { GroceryLineView } from "./groceryData";
import { UNCATEGORIZED_AISLE } from "@/lib/grocery/ingredientAisle";
import { pluralizeUnit } from "./unitFormatting";

function formatAmount(amount: number, unit: string): string {
  const rounded = Math.round(amount * 10) / 10;
  // unit.length <= 2 is this function's own existing "metric abbreviation,
  // never pluralizes, glue it directly to the number" heuristic --
  // pluralizeUnit shares the exact same threshold, so word-length units
  // (which DO space-separate here) get pluralized, short ones don't.
  return unit.length <= 2 ? `${rounded}${unit}` : `${rounded} ${pluralizeUnit(unit, rounded)}`;
}

function lineToText(line: GroceryLineView): string {
  return `${formatAmount(line.totalAmount, line.unit)} ${line.name}`;
}

// A resolved ingredient id can appear as more than one grocery line at
// once (aggregate.ts splits a same-id group whenever units disagree,
// needsManualCombine) -- (ingredient, unit) is this list's stable-ish
// render key, combined with the render index below since that pairing
// still isn't guaranteed unique on its own (a manual-combine split or a
// shared synthetic placeholder id can legitimately repeat it).
function lineKey(line: Pick<GroceryLineView, "ingredientId" | "unit">): string {
  return `${line.ingredientId}-${line.unit}`;
}

// Grouped for a real shopping trip (produce, dairy, meat, ...) rather than
// one flat alphabetical-by-name list. UNCATEGORIZED_AISLE always sorts
// last regardless of where "O" falls alphabetically among real aisle
// names, so unresolved items sit at the end instead of interrupting the
// produce/dairy/meat run.
function groupByAisle(lines: GroceryLineView[]): Array<[string, GroceryLineView[]]> {
  const groups = new Map<string, GroceryLineView[]>();
  for (const line of lines) {
    const existing = groups.get(line.aisle);
    if (existing) existing.push(line);
    else groups.set(line.aisle, [line]);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNCATEGORIZED_AISLE) return 1;
    if (b === UNCATEGORIZED_AISLE) return -1;
    return a.localeCompare(b);
  });
}

function groceryListToFile(groupedLines: Array<[string, GroceryLineView[]]>): string {
  return groupedLines
    .map(([aisle, aisleLines]) => `${aisle}\n${aisleLines.map((line) => `- ${lineToText(line)}`).join("\n")}`)
    .join("\n\n");
}

// Best-effort keyword match against KNOWN_SPOONACULAR_AISLES
// (ingredientAisle.ts) -- deliberately not exhaustive, same reasoning as
// that file's own aisle list: an AI-estimated aisle for an unusual
// ingredient can produce a label outside this list entirely, so this
// always has a generic fallback rather than assuming full coverage.
function aisleIcon(aisle: string): string {
  const a = aisle.toLowerCase();
  if (a.includes("produce")) return "🥕";
  if (a.includes("meat")) return "🍗";
  if (a.includes("seafood")) return "🐟";
  if (a.includes("cheese") || a.includes("dairy") || a.includes("milk") || a.includes("egg")) return "🧀";
  if (a.includes("bakery") || a.includes("bread")) return "🍞";
  if (a.includes("baking")) return "🧂";
  if (a.includes("pasta") || a.includes("rice")) return "🍚";
  if (a.includes("canned") || a.includes("jarred")) return "🥫";
  if (a.includes("spice") || a.includes("seasoning")) return "🌶️";
  if (a.includes("oil") || a.includes("vinegar") || a.includes("dressing")) return "🫙";
  if (a.includes("nut butter") || a.includes("jam") || a.includes("honey")) return "🍯";
  if (a.includes("nut")) return "🥜";
  if (a.includes("tea") || a.includes("coffee")) return "☕";
  if (a.includes("beverage")) return "🥤";
  if (a.includes("frozen")) return "🧊";
  if (a.includes("ethnic")) return "🍛";
  if (a.includes("health")) return "🌱";
  return "🛒";
}

export function GroceryList({ lines }: { lines: GroceryLineView[] }) {
  const [copied, setCopied] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const groupedLines = groupByAisle(lines);

  async function handleCopy() {
    await navigator.clipboard.writeText(lines.map(lineToText).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleExport() {
    const blob = new Blob([groceryListToFile(groupedLines)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "grocery-list.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  // Visual-only, resets on reload -- a shopping checklist you can tick
  // through, not a persisted server-side field. No schema/action change
  // needed for this; if usage data ever shows people want it to survive a
  // reload, that's a real follow-up, not this pass.
  function toggleChecked(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="font-display text-base font-bold text-foreground">Grocery list</h2>
        {lines.length > 0 && (
          <div className="flex items-center gap-3">
            <button type="button" onClick={handleCopy} className="text-xs font-semibold text-accent">
              {copied ? "Copied!" : "Copy list"}
            </button>
            <button type="button" onClick={handleExport} className="text-xs font-semibold text-accent">
              Export
            </button>
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        Deduped across this week&apos;s meals, snacks, and add-ons — pantry items you&apos;ve logged are left
        off.
      </p>

      {lines.length === 0 ? (
        <p className="mt-3 text-xs text-muted">Nothing to shop for yet — generate a plan first.</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groupedLines.map(([aisle, aisleLines]) => (
            <div key={aisle} className="rounded-xl bg-background p-3.5">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm" aria-hidden="true">{aisleIcon(aisle)}</span>
                <h3 className="text-[11.5px] font-bold tracking-wide text-muted uppercase">{aisle}</h3>
              </div>
              <ul className="flex flex-col">
                {aisleLines.map((line, index) => {
                  const itemKey = `${lineKey(line)}-${index}`;
                  const isChecked = checked.has(itemKey);
                  return (
                    <li key={itemKey}>
                      <button
                        type="button"
                        onClick={() => toggleChecked(itemKey)}
                        className="flex w-full items-center gap-2 border-b border-dashed border-line-soft py-1.5 text-left last:border-b-0"
                      >
                        <span
                          className={`h-3.5 w-3.5 shrink-0 rounded border transition-colors ${
                            isChecked ? "border-good bg-good" : "border-border"
                          }`}
                        />
                        <span className={`flex-1 text-sm ${isChecked ? "text-muted line-through" : "text-foreground"}`}>
                          {line.name}
                          {line.needsManualCombine && (
                            <span className="block text-xs text-muted no-underline">
                              combine manually, units didn&apos;t match
                            </span>
                          )}
                          {!line.needsManualCombine && line.viaAiEstimate && (
                            <span className="block text-xs text-muted no-underline">
                              combined via AI density estimate, double-check
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-xs text-muted tabular-nums">
                          {formatAmount(line.totalAmount, line.unit)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
