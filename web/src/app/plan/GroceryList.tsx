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

export function GroceryList({ lines }: { lines: GroceryLineView[] }) {
  const [copied, setCopied] = useState(false);
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

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Grocery list</h2>
        {lines.length > 0 && (
          <div className="flex items-center gap-3">
            <button type="button" onClick={handleCopy} className="text-xs font-semibold text-muted">
              {copied ? "Copied!" : "Copy list"}
            </button>
            <button type="button" onClick={handleExport} className="text-xs font-semibold text-muted">
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
        <div className="mt-3 flex flex-col gap-4">
          {groupedLines.map(([aisle, aisleLines]) => (
            <div key={aisle}>
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{aisle}</h3>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {aisleLines.map((line, index) => (
                  // Index appended: lineKey() (ingredientId+unit) isn't a
                  // render-uniqueness guarantee on its own -- a manual-
                  // combine split or a shared synthetic placeholder id
                  // (e.g. -1 for composed ingredients with no real
                  // Spoonacular id) can legitimately repeat it.
                  <li key={`${lineKey(line)}-${index}`} className="text-sm text-foreground">
                    {formatAmount(line.totalAmount, line.unit)} {line.name}
                    {line.needsManualCombine && (
                      <span className="ml-1.5 text-xs text-muted">— combine manually, units didn&apos;t match</span>
                    )}
                    {!line.needsManualCombine && line.viaAiEstimate && (
                      <span className="ml-1.5 text-xs text-muted">
                        — combined via AI density estimate, double-check the total
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
