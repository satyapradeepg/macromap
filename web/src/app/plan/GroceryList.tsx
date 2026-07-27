"use client";

// Epic E3 (F4). Free tier: deduped list + quantities, no prices. Pro tier
// adds a per-line price (or a manual-override input when Tavily couldn't
// resolve one) and a running weekly total (PRD 7.3 F4).

import { useState } from "react";
import type { GroceryLineView } from "./groceryData";
import { overrideGroceryPrice } from "./groceryActions";
import { UNCATEGORIZED_AISLE } from "@/lib/grocery/ingredientAisle";

function formatAmount(amount: number, unit: string): string {
  const rounded = Math.round(amount * 10) / 10;
  return unit.length <= 2 ? `${rounded}${unit}` : `${rounded} ${unit}`;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function lineToText(line: GroceryLineView): string {
  return `${formatAmount(line.totalAmount, line.unit)} ${line.name}`;
}

function PriceCell({ line, onOverride }: { line: GroceryLineView; onOverride: (priceCents: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const dollars = parseFloat(input);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError("Enter a valid price.");
      return;
    }
    setSaving(true);
    setError(null);
    const priceCents = Math.round(dollars * 100);
    const result = await overrideGroceryPrice({
      ingredientId: line.ingredientId,
      mergedIds: line.mergedIds,
      priceCents,
      totalAmount: line.totalAmount,
      unit: line.unit,
    });
    setSaving(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    onOverride(priceCents);
    setEditing(false);
  }

  if (editing) {
    return (
      <form onSubmit={handleSubmit} className="flex items-center gap-1">
        <span className="text-xs text-muted">$</span>
        <input
          type="number"
          step="0.01"
          min="0"
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="w-16 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-foreground"
        />
        <button type="submit" disabled={saving} className="text-xs font-semibold text-accent-2 disabled:opacity-60">
          {saving ? "…" : "Save"}
        </button>
        {error && <span className="text-xs text-red-500">{error}</span>}
      </form>
    );
  }

  if (line.priceCents !== null) {
    return (
      <button
        type="button"
        onClick={() => {
          setInput((line.priceCents! / 100).toFixed(2));
          setEditing(true);
        }}
        className="font-mono text-xs text-muted"
      >
        {formatCents(line.priceCents)}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="text-xs text-muted underline decoration-dotted"
    >
      $— Price unavailable — add manually
    </button>
  );
}

// A resolved ingredient id can appear as more than one grocery line at
// once (aggregate.ts splits a same-id group whenever units disagree,
// needsManualCombine) — so an override must be keyed by (ingredient,
// unit), not by ingredient id alone, or overriding one line would
// silently overwrite the displayed price of an unrelated line sharing the
// same ingredient.
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

export function GroceryList({ lines, tier }: { lines: GroceryLineView[]; tier: "free" | "pro" }) {
  const [copied, setCopied] = useState(false);
  const [priceOverrides, setPriceOverrides] = useState<Record<string, number>>({});

  async function handleCopy() {
    await navigator.clipboard.writeText(lines.map(lineToText).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const resolvedLines = lines.map((line) => ({
    ...line,
    priceCents: priceOverrides[lineKey(line)] ?? line.priceCents,
  }));

  // Contributes $0 until overridden (PRD 7.3 F4) — never fabricated.
  const weeklyTotalCents = resolvedLines.reduce((sum, line) => sum + (line.priceCents ?? 0), 0);
  const groupedLines = groupByAisle(resolvedLines);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Grocery list</h2>
        {lines.length > 0 && (
          <button type="button" onClick={handleCopy} className="text-xs font-semibold text-muted">
            {copied ? "Copied!" : "Copy list"}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        Deduped across this week&apos;s meals, snacks, and add-ons — pantry items you&apos;ve logged are left
        off.
      </p>

      {lines.length === 0 ? (
        <p className="mt-3 text-xs text-muted">Nothing to shop for yet — generate a plan first.</p>
      ) : (
        <>
          <div className="mt-3 flex flex-col gap-4">
            {groupedLines.map(([aisle, aisleLines]) => (
              <div key={aisle}>
                <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{aisle}</h3>
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {aisleLines.map((line) => (
                    <li key={lineKey(line)} className="flex items-center justify-between gap-3 text-sm text-foreground">
                      <span>
                        {formatAmount(line.totalAmount, line.unit)} {line.name}
                        {line.needsManualCombine && (
                          <span className="ml-1.5 text-xs text-muted">— combine manually, units didn&apos;t match</span>
                        )}
                        {!line.needsManualCombine && line.viaAiEstimate && (
                          <span className="ml-1.5 text-xs text-muted">
                            — combined via AI density estimate, double-check the total
                          </span>
                        )}
                      </span>
                      {tier === "pro" && (
                        <PriceCell
                          line={line}
                          onOverride={(priceCents) =>
                            setPriceOverrides((prev) => ({ ...prev, [lineKey(line)]: priceCents }))
                          }
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {tier === "pro" && (
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm font-semibold text-foreground">
              <span>Weekly total</span>
              <span className="font-mono">{formatCents(weeklyTotalCents)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
