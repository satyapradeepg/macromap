"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPersona, deletePersona, switchPersona } from "./actions";

export interface PersonaRow {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string;
}

export function Dashboard({ personas }: { personas: PersonaRow[] }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createPersona(label);
      if (result.error) {
        setError(result.error);
      } else {
        router.push("/onboarding");
      }
    });
  }

  async function handleSwitch(id: string, destination: "/plan" | "/onboarding") {
    setError(null);
    setPendingId(id);
    const result = await switchPersona(id);
    setPendingId(null);
    if (result.error) {
      setError(result.error);
    } else {
      router.push(destination);
    }
  }

  async function handleDelete(id: string, personaLabel: string) {
    if (!confirm(`Delete "${personaLabel}"? This removes its plan, pantry, and grocery data permanently.`)) {
      return;
    }
    setError(null);
    setPendingId(id);
    const result = await deletePersona(id);
    setPendingId(null);
    if (result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <h1 className="mb-1 text-lg font-semibold">Your profiles</h1>
      <p className="mb-6 text-sm text-muted">
        Choose a profile to continue, or create a new one. Each profile has
        its own plan, pantry, and grocery list.
      </p>

      <form onSubmit={handleCreate} className="mb-6 flex gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. vegan_soy_allergy"
          required
          className="flex-1 rounded border px-3 py-2"
        />
        <button
          type="submit"
          disabled={isPending}
          className="rounded border px-3 py-2 disabled:opacity-50"
        >
          {isPending ? "Creating…" : "New profile"}
        </button>
      </form>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <ul className="divide-y">
        {personas.length === 0 && (
          <li className="py-4 text-sm text-muted">No test profiles yet.</li>
        )}
        {personas.map((p) => (
          <li key={p.id} className="flex items-center justify-between py-3">
            <div>
              <p className="font-medium">{p.label}</p>
              <p className="text-xs text-muted">
                last used {new Date(p.last_used_at).toLocaleString()}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleSwitch(p.id, "/plan")}
                disabled={pendingId === p.id}
                className="rounded border px-3 py-1 text-sm disabled:opacity-50"
              >
                Switch
              </button>
              <button
                onClick={() => handleSwitch(p.id, "/onboarding")}
                disabled={pendingId === p.id}
                className="rounded border px-3 py-1 text-sm disabled:opacity-50"
              >
                Edit
              </button>
              <button
                onClick={() => handleDelete(p.id, p.label)}
                disabled={pendingId === p.id}
                className="rounded border px-3 py-1 text-sm text-red-600 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
