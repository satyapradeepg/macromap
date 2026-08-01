"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { addPantryItem, removePantryItem } from "./pantryActions";
import type { PantryItemView } from "./pantryData";

export function PantryPanel({
  initialItems,
  onPantryChange,
}: {
  initialItems: PantryItemView[];
  // Grocery-list subtraction reacts to pantry contents (aggregate.ts's
  // applyPantryItems), but that list lives in a sibling component's state
  // (PlanBoard) -- without this, adding/removing a pantry item left the
  // grocery panel showing the stale, unreduced list until a full page
  // reload (bug found live 2026-07-25).
  onPantryChange?: () => void;
}) {
  const [items, setItems] = useState<PantryItemView[]>(initialItems);
  const [name, setName] = useState("");
  const [quantityText, setQuantityText] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);

    const parsedAmount = amount.trim() ? parseFloat(amount) : null;
    const result = await addPantryItem({
      name,
      quantityText: quantityText || null,
      amount: parsedAmount,
      unit: unit || null,
    });
    setAdding(false);

    if (result.error || !result.item) {
      setError(result.error ?? "Failed to add item.");
      return;
    }
    setItems((prev) => [...prev, result.item!]);
    setName("");
    setQuantityText("");
    setAmount("");
    setUnit("");
    onPantryChange?.();
  }

  async function handleRemove(id: string) {
    setRemovingId(id);
    setError(null);

    const result = await removePantryItem(id);
    setRemovingId(null);

    if (result.error) {
      setError(result.error);
      return;
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
    onPantryChange?.();
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-foreground">Pantry</h2>
      <p className="mt-1 text-xs text-muted">
        Add ingredients you already have on hand — generation is biased toward using them. A rough note is
        fine, but adding a quantity + unit (e.g. 2, lb) lets us subtract what you have from the grocery list
        instead of leaving the ingredient off entirely. Fully optional.
      </p>

      {items.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between text-sm">
              <span className="text-foreground">
                {item.name}
                {item.amount !== null && item.unit && (
                  <span className="text-muted">
                    {" "}
                    — {item.amount} {item.unit}
                  </span>
                )}
                {item.quantityText && <span className="text-muted"> ({item.quantityText})</span>}
              </span>
              <Button
                variant="ghost"
                onClick={() => handleRemove(item.id)}
                disabled={removingId === item.id}
                className="px-0 py-0 text-xs"
              >
                {removingId === item.id ? "Removing…" : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="mt-3 flex flex-wrap gap-2">
        <Input
          size="sm"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ingredient (e.g. chicken breast)"
          required
          className="flex-1"
        />
        <Input
          size="sm"
          type="number"
          step="any"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Qty"
          className="w-20"
        />
        <Input
          size="sm"
          type="text"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="Unit (g, lb, can…)"
          className="w-32"
        />
        <Input
          size="sm"
          type="text"
          value={quantityText}
          onChange={(e) => setQuantityText(e.target.value)}
          placeholder="Note (optional)"
          className="w-32"
        />
        <Button type="submit" variant="primary" disabled={adding || !name.trim()} className="px-3 py-1.5">
          {adding ? "Adding…" : "Add"}
        </Button>
      </form>

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}
