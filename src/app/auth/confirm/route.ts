import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  CONFIRMATION_FAILED_PATH,
  confirmationRequest,
} from "@/lib/validation/auth-confirm";

/**
 * Where an emailed confirmation or recovery link lands.
 *
 * Supabase's templates send `{{ .TokenHash }}` here rather than using the default
 * `{{ .ConfirmationURL }}`, and the difference is the whole point:
 * `verifyOtp({ token_hash })` needs nothing from the browser that requested the
 * email, so the link works on a phone when the sign-up happened on a laptop. The
 * PKCE `?code=` alternative needs a code-verifier cookie from that first browser,
 * and when it is missing `auth-js` does not raise an error — it decides the URL is
 * not a callback and moves on, leaving the user signed out with a single-use token
 * already spent.
 *
 * ## Why the cookies survive the redirect
 *
 * `verifyOtp` writes the session through the same cookie handling as every other
 * server client in this application — `createSupabaseServerClient`, which calls
 * `cookies()` from `next/headers`. In a Route Handler that store is writable (it
 * is a Server Component's that is not), so the `try`/`catch` in that module never
 * fires here, and Next applies the mutated store to whatever response the handler
 * produces.
 *
 * `redirect()` from `next/navigation` is used rather than a hand-built
 * `NextResponse.redirect`, so the response is Next's to construct and the cookies
 * are attached by the framework instead of by this file remembering to copy them.
 *
 * ## What is not in the redirect
 *
 * No token, no hash, no reason. `token_hash` is single-use and would otherwise
 * end up in the address bar, the browser history and the referrer of the next
 * request. The failure case is one vague path for every cause — a wrong type, an
 * expired link, a token already spent — because distinguishing them tells an
 * unauthenticated caller which links are real.
 */
export async function GET(request: NextRequest): Promise<never> {
  const parsed = confirmationRequest(new URL(request.url).searchParams);

  if (!parsed.ok) redirect(CONFIRMATION_FAILED_PATH);

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.verifyOtp({
    type: parsed.type,
    token_hash: parsed.tokenHash,
  });

  if (error) redirect(CONFIRMATION_FAILED_PATH);

  // Already checked: either a constant, or a `next` proven to be a path on this
  // origin. See `safeNextPath`.
  redirect(parsed.destination);
}
