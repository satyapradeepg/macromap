"use client";

import { useState, type FormEvent } from "react";
import { addPantryItem, removePantryItem } from "./pantryActions";
import type { PantryItemView } from "./pantryData";

export function PantryPanel({ initialItems }: { initialItems: PantryItemView[] }) {
  const [items, setItems] = useState<PantryItemView[]>(initialItems);
  const [name, setName] = useState("");
  const [quantityText, setQuantityText] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);

    const result = await addPantryItem({ name, quantityText: quantityText || null });
    setAdding(false);

    if (result.error || !result.item) {
      setError(result.error ?? "Failed to add item.");
      return;
    }
    setItems((prev) => [...prev, result.item!]);
    setName("");
    setQuantityText("");
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
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-foreground">Pantry</h2>
      <p className="mt-1 text-xs text-muted">
        Add ingredients you already have on hand — generation is biased toward using them, and they&apos;re
        left off your grocery list. Fully optional.
      </p>

      {items.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between text-sm">
              <span className="text-foreground">
                {item.name}
                {item.quantityText && <span className="text-muted"> — {item.quantityText}</span>}
              </span>
              <button
                type="button"
                onClick={() => handleRemove(item.id)}
                disabled={removingId === item.id}
                className="text-xs font-semibold text-muted disabled:opacity-60"
              >
                {removingId === item.id ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="mt-3 flex flex-wrap gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ingredient (e.g. chicken breast)"
          required
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
        />
        <input
          type="text"
          value={quantityText}
          onChange={(e) => setQuantityText(e.target.value)}
          placeholder="Rough quantity (optional)"
          className="w-40 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
        />
        <button
          type="submit"
          disabled={adding || !name.trim()}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {adding ? "Adding…" : "Add"}
        </button>
      </form>

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}
