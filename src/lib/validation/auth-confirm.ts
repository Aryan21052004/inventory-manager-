/**
 * The rules behind `/auth/confirm`, the route an emailed auth link lands on.
 *
 * Pure, and in its own module rather than inside the route file, for two
 * reasons. A `route.ts` may only export request handlers, so helpers exported
 * from one are a hazard; and the decisions here — which verification types are
 * accepted, and where a `next` parameter is allowed to send someone — are
 * security decisions that should be testable without a request, a server or a
 * browser.
 *
 * ## Why this route exists at all
 *
 * Supabase's default email templates use `{{ .ConfirmationURL }}`, which returns
 * the browser to the site with a PKCE `?code=`. Exchanging that code requires the
 * code-verifier cookie written when the form was submitted — so the link only
 * works in the same browser that asked for it. People open email on their phone.
 * When the verifier is missing, `@supabase/auth-js` does not error: it decides
 * the URL is not a callback and carries on, leaving the user silently signed out
 * with a single-use token already spent.
 *
 * `verifyOtp({ token_hash, type })` needs no verifier, so a link verified here
 * works from any device. The cost is that the email templates have to send
 * `{{ .TokenHash }}` to this route instead of the default URL.
 */

/** Where a failure goes. One destination for every way this can fail. */
export const CONFIRMATION_FAILED_PATH = "/sign-in?error=confirmation";

export const EMAIL_DESTINATION = "/dashboard";
export const RECOVERY_DESTINATION = "/reset-password";

/**
 * The verification types this application sends emails for, and therefore the
 * only ones it will act on.
 *
 * Narrower than Supabase's `EmailOtpType`, on purpose. That type ends in
 * `(string & {})`, so it accepts any string and would let a crafted link ask for
 * a flow this app never initiates — `email_change`, for instance, which would
 * confirm an address change nobody requested here. A closed union makes an
 * unexpected `type` a rejection rather than an attempt.
 */
export type ConfirmationType = "email" | "recovery";

export type ConfirmationRequest =
  | { ok: false }
  | {
      ok: true;
      type: ConfirmationType;
      tokenHash: string;
      destination: string;
    };

/**
 * Query parameters that must never be carried into a redirect, even inside an
 * otherwise acceptable relative path.
 *
 * A `next` of `/dashboard?token_hash=…` is a path on this origin and passes every
 * other rule here, but it would put a single-use credential into the address bar,
 * the browser history, and any referrer header that follows.
 */
const FORBIDDEN_IN_NEXT = /token_hash|access_token|refresh_token/i;

/**
 * A `next` parameter, if it is a path on this origin, or null.
 *
 * Each rule below is a separate way out of the origin, and they are checked
 * separately rather than with one clever pattern — relying on a single check for
 * several different attacks is how one of them comes back.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Any scheme at all: `javascript:`, `data:`, `https:`. Checked first so
  // `javascript:alert(1)` is rejected for being a scheme rather than
  // incidentally for lacking a leading slash.
  if (/^[a-z][a-z0-9+.\-]*:/i.test(raw)) return null;

  // Control characters and whitespace. Browsers strip some of these before
  // resolving a Location header, so `\t//evil.example` can become
  // `//evil.example` after this function has approved it.
  if (/[\u0000- \u007f]/.test(raw)) return null;

  // Backslashes. Several browsers normalise `\` to `/` in a URL, which turns
  // `/\evil.example` into `//evil.example`.
  if (raw.includes("\\")) return null;

  // Must be an absolute path on this origin — and exactly one slash, because
  // `//host` is protocol-relative and leaves the site entirely.
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;

  if (FORBIDDEN_IN_NEXT.test(raw)) return null;

  return raw;
}

/**
 * Reads a confirmation request, deciding whether to act on it and where it ends.
 *
 * Returns `{ ok: false }` for anything unusable rather than throwing: the caller
 * has exactly one thing to do about it, and an exception here would be caught and
 * turned back into the same redirect.
 */
export function confirmationRequest(
  params: URLSearchParams,
): ConfirmationRequest {
  const tokenHash = params.get("token_hash");
  const type = params.get("type");

  if (!tokenHash) return { ok: false };
  if (type !== "email" && type !== "recovery") return { ok: false };

  const fallback =
    type === "recovery" ? RECOVERY_DESTINATION : EMAIL_DESTINATION;

  return {
    ok: true,
    type,
    tokenHash,
    destination: safeNextPath(params.get("next")) ?? fallback,
  };
}

/**
 * The absolute URL an email link should come back to.
 *
 * Built with `URL` rather than string concatenation so `next` is percent-encoded
 * by the platform: `/reset-password` becomes `next=%2Freset-password`, which is
 * what stops a path containing its own query string from being read as part of
 * this one.
 *
 * The origin is supplied by the caller — `window.location.origin` in the browser
 * — so no hostname is written down here. A production domain in source would send
 * a developer's confirmation link to production.
 */
export function confirmCallbackUrl(origin: string, next?: string): string {
  const url = new URL("/auth/confirm", origin);

  if (next) url.searchParams.set("next", next);

  return url.toString();
}
