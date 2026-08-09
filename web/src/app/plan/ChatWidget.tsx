"use client";

// Conversational plan assistant (F11) -- a floating widget, not a modal:
// deliberately no backdrop (unlike RecipeModal's fixed-overlay idiom this
// otherwise mirrors) since the point is to keep browsing/editing the plan
// while chatting, not to block it. Plain useState + a direct await on the
// server action, same convention as PantryPanel.handleAdd/PlanView's
// handleSwap -- no useTransition (that's reserved for a client-side
// router.push navigation elsewhere in this app, not a server action call
// itself).

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { Spinner } from "@/components/ui/Spinner";
import { sendChatMessage } from "./chatActions";
import type { PlanSlotView, PlanView } from "./data";
import type { PantryItemView } from "./pantryData";
import type { MacroTargets } from "@/lib/mealplan/targets";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// A profile/constraint edit triggers a real plan regeneration
// (OnboardingWizard.tsx's own GENERATING_STATUS_MESSAGES documents this
// same pipeline running 50-90s+) -- but unlike onboarding's screen, THIS
// widget doesn't know in advance which kind of request a message is, and
// most chat turns finish in a few seconds. So: an immediate typing
// indicator covers the common fast case, and only after a real delay does
// the message change to something that explains the one known slow case,
// rather than fabricating fake pipeline "stages" for a request that isn't
// actually regenerating anything.
const SLOW_REQUEST_THRESHOLD_MS = 8000;

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
  const [slowRequest, setSlowRequest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, sending]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || sending) return;

    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setInput("");
    setSending(true);
    setSlowRequest(false);
    setError(null);

    const slowTimer = setTimeout(() => setSlowRequest(true), SLOW_REQUEST_THRESHOLD_MS);
    const result = await sendChatMessage({ message });
    clearTimeout(slowTimer);
    setSending(false);
    setSlowRequest(false);

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
        {sending && (
          <div className="flex justify-start">
            <div className="flex max-w-[85%] items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted">
              <Spinner className="h-3.5 w-3.5 shrink-0" />
              {slowRequest
                ? "Still working on it -- if this involves regenerating your plan, that can take up to a couple of minutes."
                : "Thinking…"}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
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
