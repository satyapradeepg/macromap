"use client";

// Conversational plan assistant (F11) -- a floating widget, not a modal:
// deliberately no backdrop (unlike RecipeModal's fixed-overlay idiom this
// otherwise mirrors) since the point is to keep browsing/editing the plan
// while chatting, not to block it. Plain useState + a direct await on the
// server action, same convention as PantryPanel.handleAdd/PlanView's
// handleSwap -- no useTransition (that's reserved for a client-side
// router.push navigation elsewhere in this app, not a server action call
// itself).

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { sendChatMessage } from "./chatActions";
import type { PlanSlotView, PlanView } from "./data";
import type { PantryItemView } from "./pantryData";
import type { MacroTargets } from "@/lib/mealplan/targets";

interface ChatMessage {
  role: "user" | "assistant" | "error";
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

// Same stroke-icon convention as dishIcon.ts's DISH_ICON_PATHS (viewBox
// 0 0 24 24, fill none, stroke currentColor, round caps/joins) -- kept
// consistent with the one other hand-drawn icon set in this app rather
// than introducing a different visual language or an icon-package
// dependency neither this app nor this component otherwise needs.
function ChatBubbleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12l16-8-6 16-2.5-6.5L4 12z" />
    </svg>
  );
}

function TypingIndicator({ slowRequest }: { slowRequest: boolean }) {
  return (
    <div className="flex justify-start animate-chat-message-in motion-reduce:animate-none">
      <div className="flex max-w-[85%] items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted">
        <span className="flex items-center gap-1" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-muted animate-chat-bounce motion-reduce:animate-none"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
        <span className="sr-only">Assistant is typing</span>
        {slowRequest && (
          <span>Still working on it -- if this involves regenerating your plan, that can take up to a couple of minutes.</span>
        )}
      </div>
    </div>
  );
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
  const [unread, setUnread] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [slowRequest, setSlowRequest] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // handleSend's closure captures `open` from whenever the request
  // started -- if the user closes the panel WHILE a slow request (e.g. a
  // profile-edit regeneration) is still in flight, that stale `open`
  // would still read true when the reply lands, so the unread badge never
  // set. A ref always reflects the CURRENT value, not the one captured at
  // call time.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, sending]);

  // Matches RecipeModal's own Escape-to-close convention exactly.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Auto-focus on open, and again after every reply -- a chat widget you
  // have to keep re-clicking into to send a follow-up message reads as
  // unfinished, not polished.
  useEffect(() => {
    if (open && !sending) textareaRef.current?.focus();
  }, [open, sending]);

  // Auto-growing textarea (capped, then scrolls internally) -- a plain
  // rows=1 textarea silently scrolls earlier lines out of view the moment
  // Shift+Enter wraps to a second line, which reads as the app having
  // eaten what was just typed. Resets to its single-line height whenever
  // input is cleared (after sending).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!input) {
      // Measuring scrollHeight while empty picks up the placeholder's own
      // intrinsic wrap width, not the real (empty) content -- reset to
      // the natural rows=1 height instead of trusting that number.
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  }, [input]);

  async function handleSend(e: FormEvent | KeyboardEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || sending) return;

    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setInput("");
    setSending(true);
    setSlowRequest(false);

    const slowTimer = setTimeout(() => setSlowRequest(true), SLOW_REQUEST_THRESHOLD_MS);
    const result = await sendChatMessage({ message });
    clearTimeout(slowTimer);
    setSending(false);
    setSlowRequest(false);

    if (result.error) {
      setMessages((prev) => [...prev, { role: "error", content: result.error! }]);
      return;
    }

    setMessages((prev) => [...prev, { role: "assistant", content: result.reply }]);
    if (!openRef.current) setUnread(true);

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
        className="fixed bottom-4 right-4 z-40 gap-2 shadow-lg transition-transform hover:scale-105 motion-reduce:transform-none"
        onClick={() => {
          setOpen(true);
          setUnread(false);
        }}
      >
        <ChatBubbleIcon />
        Chat
        {unread && (
          <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-accent-2 ring-2 ring-surface" aria-label="New reply" />
        )}
      </Button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex h-[28rem] w-80 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl animate-chat-in motion-reduce:animate-none">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <ChatBubbleIcon />
          Plan assistant
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full p-1 text-sm text-muted transition-colors hover:bg-background hover:text-foreground"
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
          <div key={i} className={`flex animate-chat-message-in motion-reduce:animate-none ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                m.role === "user"
                  ? "bg-accent text-white"
                  : m.role === "error"
                    ? "border border-red-600/40 text-red-600"
                    : "border border-border bg-background text-foreground"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && <TypingIndicator slowRequest={slowRequest} />}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} className="flex items-end gap-2 border-t border-border p-2">
        <Textarea
          ref={textareaRef}
          size="sm"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask me anything about your plan..."
          className="max-h-28 resize-none overflow-y-auto"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              handleSend(e);
            }
          }}
        />
        <Button type="submit" variant="primary" className="gap-1.5" loading={sending} loadingText="…" disabled={!input.trim()}>
          <SendIcon />
          Send
        </Button>
      </form>
    </div>
  );
}
