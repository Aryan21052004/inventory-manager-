"use client";

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CircleAlert,
  Loader2,
  RotateCcw,
  SendHorizontal,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The chat panel.
 *
 * The conversation lives in this component's state and nowhere else: it is not
 * stored on the server, and it is gone when the page is left. Each question
 * sends the text of the conversation so far — never any data the server looked
 * up — and the server re-runs whatever lookups the answer needs under the
 * current session.
 *
 * Answers are rendered as plain text. The model is told to write plain text,
 * and rendering it as such means nothing it writes can become markup, an image
 * the browser fetches, or a link off the site. The one exception is an in-app
 * path such as `/orders/…`, which becomes an ordinary link; the "Open" chips
 * under an answer are built by the server from database ids, not by the model.
 */

interface Source {
  label: string;
  href: string;
}

interface Step {
  tool: string;
  label: string;
  ok: boolean;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  steps?: Step[];
  /** A failed request. Shown, but never sent back as conversation. */
  failed?: boolean;
}

/** Mirrors the route's limits, so the client trims before the server refuses. */
const MAX_SENT_MESSAGES = 20;
const MAX_SENT_CHARACTERS = 24_000;
const MAX_QUESTION_CHARACTERS = 4_000;

const SUGGESTIONS = [
  "What's our inventory value?",
  "Which products have no available stock?",
  "What was our revenue this month?",
  "What are our most recent orders?",
  "How many units did we sell this month?",
  "What's our current costing situation?",
];

/** The tail of the conversation the server will accept, oldest dropped first. */
function transcript(messages: readonly Message[]): { role: Message["role"]; content: string }[] {
  const sendable = messages
    .filter((message) => !message.failed)
    .map(({ role, content }) => ({ role, content }));

  let kept = sendable.slice(-MAX_SENT_MESSAGES);

  while (
    kept.length > 1 &&
    kept.reduce((sum, message) => sum + message.content.length, 0) > MAX_SENT_CHARACTERS
  ) {
    kept = kept.slice(1);
  }

  return kept;
}

/**
 * In-app paths the answer may mention. Anything else — a full URL, a path to
 * somewhere this app does not have — stays plain text.
 */
const IN_APP_PATH =
  /(^|[\s(])(\/(?:dashboard|products|stock-movements|orders|purchases|returns|customers|suppliers|reports|assistant)(?:\/[\w%-]+)*(?:\?[\w%=&.-]+)?)/g;

function withLinks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(IN_APP_PATH)) {
    const [, lead = "", path = ""] = match;
    const start = (match.index ?? 0) + lead.length;
    // A trailing full stop or comma ends the sentence, not the path.
    const trimmed = path.replace(/[.,;:]+$/, "");

    nodes.push(text.slice(last, start));
    nodes.push(
      <Link key={start} href={trimmed} className="text-primary underline-offset-4 hover:underline">
        {trimmed}
      </Link>,
    );
    last = start + trimmed.length;
  }

  nodes.push(text.slice(last));
  return nodes;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function AssistantChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const endOfList = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endOfList.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  // A question still in flight when the page is left is abandoned, not answered
  // into a component that no longer exists.
  useEffect(() => () => controller.current?.abort(), []);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || pending) return;

    const asked: Message = { id: newId(), role: "user", content: text };
    const conversation = [...messages, asked];

    setMessages(conversation);
    setDraft("");
    setPending(true);

    const abort = new AbortController();
    controller.current = abort;

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: transcript(conversation) }),
        signal: abort.signal,
      });

      const body = (await response.json().catch(() => null)) as
        | { answer?: string; sources?: Source[]; steps?: Step[]; error?: string }
        | null;

      if (!response.ok || !body?.answer) {
        // The server's own sentence when it sent one — it is written to be
        // shown — and a fallback for a response that carried none.
        const message =
          body?.error ??
          (response.status === 401
            ? "Your session has ended. Sign in again to keep using the assistant."
            : "The assistant couldn't answer just now. Please try again.");

        setMessages((current) => [
          ...current,
          { id: newId(), role: "assistant", content: message, failed: true },
        ]);
        return;
      }

      setMessages((current) => [
        ...current,
        {
          id: newId(),
          role: "assistant",
          content: body.answer!,
          sources: body.sources ?? [],
          steps: body.steps ?? [],
        },
      ]);
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error("[inventory-manager] assistant request failed", error);

      setMessages((current) => [
        ...current,
        {
          id: newId(),
          role: "assistant",
          content: "The assistant couldn't be reached. Check your connection and try again.",
          failed: true,
        },
      ]);
    } finally {
      if (controller.current === abort) controller.current = null;
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a new line. Not while an IME is composing.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(draft);
    }
  }

  function startOver() {
    controller.current?.abort();
    controller.current = null;
    setMessages([]);
    setPending(false);
  }

  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
        <div className="flex flex-col gap-4" aria-live="polite" aria-busy={pending}>
          {messages.length === 0 ? (
            <div className="flex flex-col items-start gap-3 py-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Sparkles className="size-4 text-primary" aria-hidden />
                Try one of these, or ask your own question:
              </div>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <Button
                    key={suggestion}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void ask(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                  {message.content}
                </p>
              </div>
            ) : (
              <div key={message.id} className="flex flex-col gap-2">
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed",
                    message.failed
                      ? "border-destructive/40 bg-destructive/5"
                      : "border-border bg-muted/40",
                  )}
                >
                  {message.failed ? (
                    <span className="flex items-start gap-2">
                      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                      {message.content}
                    </span>
                  ) : (
                    withLinks(message.content).map((node, index) => (
                      <Fragment key={index}>{node}</Fragment>
                    ))
                  )}
                </div>

                {message.sources && message.sources.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {message.sources.map((source) => (
                      <Button key={source.href} asChild variant="outline" size="sm">
                        <Link href={source.href}>
                          {source.label}
                          <ArrowUpRight aria-hidden />
                        </Link>
                      </Button>
                    ))}
                  </div>
                ) : null}

                {message.steps && message.steps.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Looked up:{" "}
                    {message.steps
                      .map((step) => (step.ok ? step.label : `${step.label} (failed)`))
                      .join(", ")}
                  </p>
                ) : null}
              </div>
            ),
          )}

          {pending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Looking that up…
            </div>
          ) : null}

          <div ref={endOfList} />
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-2 border-t border-border pt-4">
          <label htmlFor="assistant-question" className="sr-only">
            Your question
          </label>
          <Textarea
            id="assistant-question"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. How many units of part ABC123 do we have?"
            maxLength={MAX_QUESTION_CHARACTERS}
            rows={2}
            disabled={pending}
            className="resize-none"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Read-only. Answers are generated by AI from live data — check important figures on the linked pages.
            </p>
            <div className="flex items-center gap-2">
              {messages.length > 0 ? (
                <Button type="button" variant="ghost" size="sm" onClick={startOver}>
                  <RotateCcw aria-hidden />
                  New conversation
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={pending || draft.trim() === ""}>
                <SendHorizontal aria-hidden />
                Ask
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export { AssistantChat };
