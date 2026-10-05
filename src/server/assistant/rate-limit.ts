import "server-only";

import { AppError } from "@/lib/errors";

/**
 * A per-user ceiling on assistant questions.
 *
 * Every question costs a model call or several, so a stuck client or a script
 * replaying a signed-in user's cookie should not be able to run up the bill
 * unchecked.
 *
 * **Per server instance, and best-effort.** The counts live in this process's
 * memory, so on a host that runs several instances — Vercel scales functions
 * out — a user can get up to the limit on each. Holding it across instances
 * needs a shared store (a database table or a key-value service), which this
 * phase deliberately does not add. The provider's own quota is the hard limit
 * behind this one.
 */

export const ASSISTANT_RATE_LIMIT = {
  /** Questions allowed per user per window. */
  requests: 20,
  windowMs: 5 * 60 * 1000,
} as const;

const recent = new Map<string, number[]>();

/** Records a question for this user, or refuses it with RATE_LIMITED. */
export function consumeAssistantQuota(userId: string, now = Date.now()): void {
  const windowStart = now - ASSISTANT_RATE_LIMIT.windowMs;
  const kept = (recent.get(userId) ?? []).filter((at) => at > windowStart);

  if (kept.length >= ASSISTANT_RATE_LIMIT.requests) {
    recent.set(userId, kept);
    throw new AppError(
      "RATE_LIMITED",
      "You've asked a lot of questions in a short time. Please wait a few minutes and try again.",
    );
  }

  kept.push(now);
  recent.set(userId, kept);

  // Keep the map from growing without bound on a long-lived instance.
  if (recent.size > 5_000) {
    for (const [key, times] of recent) {
      if (times.every((at) => at <= windowStart)) recent.delete(key);
    }
  }
}

/** Test seam: forget every recorded question. */
export function resetAssistantQuota(): void {
  recent.clear();
}
