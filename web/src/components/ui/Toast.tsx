"use client";

import { useEffect, useState } from "react";
import { subscribeToToasts, type ToastMessage } from "@/lib/toast";

const AUTO_DISMISS_MS = 3500;

// Mounted once in layout.tsx. Reuses the app's existing
// chat-message-in-style entrance keyframe convention rather than
// introducing a new animation vocabulary, paired with
// motion-reduce:animate-none per the house accessibility rule.
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    return subscribeToToasts((toast) => {
      setToasts((current) => [...current, toast]);
      setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== toast.id));
      }, AUTO_DISMISS_MS);
    });
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`animate-chat-message-in motion-reduce:animate-none pointer-events-auto rounded-full border px-4 py-2 text-sm font-medium shadow-lg ${
            toast.tone === "error"
              ? "border-warn/40 bg-warn/10 text-warn"
              : "border-good/40 bg-good/10 text-good"
          }`}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}
