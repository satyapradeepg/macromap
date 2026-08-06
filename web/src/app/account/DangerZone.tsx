"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { deleteAccount } from "./actions";

export function DangerZone() {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    const result = await deleteAccount();
    // A successful delete redirect()s server-side and never returns here.
    if (result?.error) {
      setError(result.error);
      setDeleting(false);
    }
  }

  return (
    <Card className="mt-8 p-5">
      <h2 className="text-sm font-bold text-red-600">Danger zone</h2>
      <p className="mt-1 text-sm text-muted">
        Permanently deletes your account, meal plans, pantry, and grocery price overrides. This
        can&apos;t be undone.
      </p>

      {!confirming ? (
        <Button variant="destructive" className="mt-4" onClick={() => setConfirming(true)}>
          Delete account
        </Button>
      ) : (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-red-600/30 bg-red-600/5 p-4">
          <p className="text-sm font-semibold text-red-600">
            Are you sure? Everything will be permanently deleted, and you won&apos;t be able to
            log back in.
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Yes, delete everything"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
