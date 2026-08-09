"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { requestPasswordReset } from "./actions";

export function AccountIdentity({ email, name }: { email: string | null; name: string | null }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    setSending(true);
    setError(null);
    const result = await requestPasswordReset();
    setSending(false);
    if (result.error) setError(result.error);
    else setSent(true);
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-bold text-muted uppercase tracking-wide">Account</h2>
      <dl className="mt-3 flex flex-col gap-2 text-sm">
        {name && (
          <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
            <dt className="text-muted">Name</dt>
            <dd className="font-medium break-all sm:text-right">{name}</dd>
          </div>
        )}
        <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
          <dt className="text-muted">Email</dt>
          <dd className="font-medium break-all sm:text-right">{email ?? "—"}</dd>
        </div>
      </dl>

      <div className="mt-4">
        {sent ? (
          <p className="text-sm text-accent">Check your email for a reset link.</p>
        ) : (
          <Button variant="secondary" onClick={handleReset} disabled={sending}>
            {sending ? "Sending…" : "Reset password"}
          </Button>
        )}
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    </Card>
  );
}
