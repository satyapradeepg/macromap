"use client";

// Conversational plan assistant (F11) -- a floating widget, not a modal:
// deliberately no backdrop (unlike RecipeModal's fixed-overlay idiom this
// otherwise mirrors) since the point is to keep browsing/editing the plan
// while chatting, not to block it. Plain useState + a direct await on the
// server action, same convention as PantryPanel.handleAdd/PlanView's
// handleSwap -- no useTransition (that's reserved for a client-side
// router.push navigation elsewhere in this app, not a server action call
// itself).

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { sendChatMessage } from "./chatActions";
import type { PlanSlotView, PlanView } from "./data";
import type { PantryItemView } from "./pantryData";
import type { MacroTargets } from "@/lib/mealplan/targets";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function ChatWidget({
  onSlotReplaced,
  onPlanReplaced,
  onPantryReplaced,
}: {
  onSlotReplaced?: (slot: PlanSlotView, weeklyActual: MacroTargets) => void;
  onPlanReplaced?: (plan: PlanView) => void;
  onPantryReplaced?: (items: PantryItemView[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || sending) return;

    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setInput("");
    setSending(true);
    setError(null);

    const result = await sendChatMessage({ message });
    setSending(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    setMessages((prev) => [...prev, { role: "assistant", content: result.reply }]);

    if (result.updatedSlot && result.updatedWeeklyActual) {
      onSlotReplaced?.(result.updatedSlot, result.updatedWeeklyActual);
    }
    if (result.updatedPlan) {
      onPlanReplaced?.(result.updatedPlan);
    }
    if (result.updatedPantryItems) {
      onPantryReplaced?.(result.updatedPantryItems);
    }
  }

  if (!open) {
    return (
      <Button
        variant="primary"
        className="fixed bottom-4 right-4 z-40 shadow-lg"
        onClick={() => setOpen(true)}
      >
        Chat
      </Button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex h-[28rem] w-80 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold text-foreground">Plan assistant</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-muted hover:text-foreground"
          aria-label="Close chat"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="text-sm text-muted">
            Try &ldquo;swap tomorrow&rsquo;s dinner&rdquo;, &ldquo;I have chicken and rice&rdquo;, or &ldquo;I&rsquo;m allergic to peanuts now&rdquo;.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                m.role === "user" ? "bg-accent text-white" : "border border-border bg-background text-foreground"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
      </div>

      {error && <p className="px-3 pb-1 text-sm text-red-500">{error}</p>}

      <form onSubmit={handleSend} className="flex items-end gap-2 border-t border-border p-2">
        <Textarea
          size="sm"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask me anything about your plan..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend(e);
            }
          }}
        />
        <Button type="submit" variant="primary" loading={sending} loadingText="..." disabled={!input.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
