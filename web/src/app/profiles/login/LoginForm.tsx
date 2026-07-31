"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { checkCredentials } from "./actions";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await checkCredentials(username, password);
    if (result.error) {
      setError(result.error);
      setSubmitting(false);
    } else {
      router.push("/profiles");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <input
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Username"
        autoFocus
        required
        autoComplete="username"
        className="rounded border px-3 py-2"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        required
        autoComplete="current-password"
        className="rounded border px-3 py-2"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded border px-3 py-2 disabled:opacity-50"
      >
        {submitting ? "Checking…" : "Enter"}
      </button>
    </form>
  );
}
