"use client";

// Conversational plan assistant (F7) -- a floating widget, not a modal:
// deliberately no backdrop (unlike RecipeModal's fixed-overlay idiom this
// otherwise mirrors) since the point is to keep browsing/editing the plan
// while chatting, not to block it. Plain useState + a direct await on the
// server action, same convention as PantryPanel.handleAdd/PlanView's
// handleSwap -- no useTransition (that's reserved for a client-side
// router.push navigation elsewhere in this app, not a server action call
// itself).

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Textarea } from "@/components/ui/Textarea";
import { sendChatMessage, getChatHistory, clearChatHistory } from "./chatActions";
import type { PlanSlotView, PlanView } from "./data";
import type { PantryItemView } from "./pantryData";
import type { MacroTargets } from "@/lib/mealplan/targets";

interface ChatMessage {
  role: "user" | "assistant" | "error";
  content: string;
}

// Shown only on a genuinely fresh conversation (no history to load, no
// messages sent yet) -- a tappable starting point is a real usability win
// over a wall of quote-marked example text the user has to retype
// themselves. Deliberately not auto-sent on click: fills the box so the
// user can still edit ("swap tomorrow's dinner" -> "swap Friday's
// dinner") before committing.
// "I have chicken and rice" (the prior third suggestion) demonstrated the
// pantry feature but was vague about what it'd do to a first-time user and
// didn't showcase this app's actual flagship differentiator -- F7 chat
// meal EDITING (add/remove/adjust a real ingredient), which none of the
// three previously touched at all. Live-tested 2026-08-10 for reliability
// before picking this specific wording: a plain seasoning add/increase
// never conflicts with any dietary style or allergy and is never a
// duplicate-role candidate, so it's virtually guaranteed to succeed
// smoothly regardless of the viewer's own profile -- a bad first
// impression here (an edge-case rejection) would undersell the feature.
// "What's left in my week?" (2026-08-13, replaced) was genuinely ambiguous
// -- left of what: macros, meals, or groceries? Now showcases a distinct
// real capability instead (intentClassifier's pantry_contents QA topic),
// diversifying the 3 suggestions to swap / edit / pantry rather than
// swap / edit / macros.
const QUICK_SUGGESTIONS = ["Swap tonight's dinner", "Add extra black pepper to today's lunch", "What's in my pantry?"];

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

function AssistantAvatar() {
  return (
    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
      <ChatBubbleIcon />
    </span>
  );
}

function TypingIndicator({ slowRequest }: { slowRequest: boolean }) {
  return (
    <div className="flex items-start gap-1.5 animate-chat-message-in motion-reduce:animate-none">
      <AssistantAvatar />
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
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [slowRequest, setSlowRequest] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
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

  // Loads the persisted transcript (chat_messages, since PR1) the first
  // time the panel is opened -- lazy rather than on mount, since most
  // page loads never open the chat at all and this avoids a query for
  // those. Triggered directly from the launcher's onClick (the only path
  // that ever sets open=true) rather than an effect keyed on `open`, so
  // there's no risk of firing on every open/close toggle. Prepends rather
  // than replacing in case the user typed something before this resolved.
  function openWidget() {
    setOpen(true);
    setUnread(false);
    if (historyLoaded) return;
    setHistoryLoaded(true);
    getChatHistory().then((history) => {
      if (history.length === 0) return;
      setMessages((prev) => [...history, ...prev]);
    });
  }

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
    // Defense-in-depth alongside chatActions.ts's own try/catch around its
    // slowest paths (profile-edit regeneration): this catches ANY rejected
    // call (a network drop, an unrelated server error), not just the one
    // known cause -- without it, "sending" would stay true forever with no
    // way to recover short of a page reload, same class of bug found and
    // fixed at every other generatePlan() call site tonight.
    let result;
    try {
      result = await sendChatMessage({ message });
    } catch {
      clearTimeout(slowTimer);
      setSending(false);
      setSlowRequest(false);
      setMessages((prev) => [
        ...prev,
        { role: "error", content: "That took too long to get a reply. It may still be processing -- try again in a moment." },
      ]);
      return;
    }
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

  // Deletes the persisted transcript, not just the client-side view --
  // otherwise the next reload's history load would silently bring back
  // what was just "cleared." The only way to reset a conversation short
  // of deleting the whole account (DangerZone.tsx).
  async function handleClearHistory() {
    setClearing(true);
    const result = await clearChatHistory();
    setClearing(false);
    setConfirmingClear(false);
    if (result.error) {
      setMessages((prev) => [...prev, { role: "error", content: `Couldn't clear the conversation: ${result.error}` }]);
      return;
    }
    setMessages([]);
  }

  if (!open) {
    return (
      <Button
        variant="primary"
        className="fixed bottom-4 right-4 z-40 gap-2 shadow-lg transition-transform hover:scale-105 motion-reduce:transform-none"
        onClick={openWidget}
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
    <div
      className={
        // Below `sm`, a small floating box leaves almost no room to
        // actually read a conversation on a phone -- expands to a
        // near-full-height sheet instead, the same responsive pattern
        // production chat widgets (Intercom, Crisp) use. `sm:` and up
        // reverts to the compact corner-anchored box.
        "fixed inset-x-3 bottom-3 top-16 z-40 flex flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl animate-chat-in motion-reduce:animate-none " +
        "sm:inset-x-auto sm:top-auto sm:right-4 sm:bottom-4 sm:h-[28rem] sm:w-80"
      }
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <ChatBubbleIcon />
          Plan assistant
        </span>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmingClear(true)}
              className="rounded-full px-2 py-1 text-xs font-semibold text-muted transition-colors hover:bg-background hover:text-foreground"
              aria-label="Clear conversation"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-full p-1 text-sm text-muted transition-colors hover:bg-background hover:text-foreground"
            aria-label="Close chat"
          >
            ✕
          </button>
        </div>
      </div>

      {confirmingClear && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-600/30 bg-red-600/5 px-3 py-2 text-sm">
          <span className="text-red-600">Clear this conversation?</span>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setConfirmingClear(false)}
              disabled={clearing}
              className="text-xs font-semibold text-muted hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleClearHistory}
              disabled={clearing}
              className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50"
            >
              {clearing ? "Clearing…" : "Clear"}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {historyLoaded && messages.length === 0 && (
          <p className="text-sm text-muted">Try one of these, or ask anything about your plan:</p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex animate-chat-message-in motion-reduce:animate-none ${m.role === "user" ? "justify-end" : "items-start gap-1.5"}`}
          >
            {m.role !== "user" && <AssistantAvatar />}
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
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

      {/* Persistent, not gated on messages.length === 0 -- previously these
          only ever rendered inside the scrolling message list (see above),
          so once a conversation had ANY history at all (this account's
          real, live state -- confirmed 2026-08-13) the suggestions were
          gone permanently, not just scrolled past. Living just above the
          input instead means they're reachable on every open, regardless
          of how long the conversation is. */}
      {historyLoaded && (
        <div className="flex flex-wrap gap-1.5 border-t border-border p-2 pb-0">
          {QUICK_SUGGESTIONS.map((suggestion) => (
            <Pill
              key={suggestion}
              size="sm"
              onClick={() => {
                setInput(suggestion);
                textareaRef.current?.focus();
              }}
            >
              {suggestion}
            </Pill>
          ))}
        </div>
      )}

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
