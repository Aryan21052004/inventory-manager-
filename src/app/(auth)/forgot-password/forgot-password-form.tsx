"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  confirmCallbackUrl,
  RECOVERY_DESTINATION,
} from "@/lib/validation/auth-confirm";
import {
  genericErrorMessage,
  PASSWORD_RESET_SENT,
  validatePasswordResetRequest,
  type AuthFieldErrors,
} from "@/lib/validation/auth";

/**
 * Asks Supabase to email a recovery link.
 *
 * ## The success message is the security feature
 *
 * It says "if that address has an account" and shows regardless of whether one
 * does. This form is reachable by anyone, so a response that differed between a
 * known and an unknown address would let anyone enumerate the installation's
 * users. The provider's own error is not shown either, for the same reason.
 *
 * ## `window.location.origin`, never a configured hostname
 *
 * The redirect target is built from wherever the page is actually being served.
 * Hardcoding a production host would send a developer's reset link to
 * production, and reusing the old Clerk redirect variables would point it at a
 * provider this application no longer uses. Supabase still has to allow the
 * resulting URL in its redirect list — that is a project setting, not a value
 * this file should pretend to know.
 */
export function ForgotPasswordForm() {
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const result = validatePasswordResetRequest({
      email: String(form.get("email") ?? ""),
    });

    setFormError(null);

    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }

    setFieldErrors({});

    startTransition(async () => {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.resetPasswordForEmail(
        result.value.email,
        /*
         * Through /auth/confirm rather than straight to /reset-password.
         * The direct link arrives as a PKCE `?code=`, which can only be
         * exchanged in the browser that asked for the reset — so a link
         * opened on a phone would fail, and fail silently. The callback
         * route verifies the token server-side instead and needs nothing
         * from this browser.
         */
        {
          redirectTo: confirmCallbackUrl(
            window.location.origin,
            RECOVERY_DESTINATION,
          ),
        },
      );

      /*
       * Only a rate limit is reported, and only because it is about the
       * requester rather than the address. Anything else — including "no such
       * user" — resolves to the same panel below.
       */
      if (error && genericErrorMessage(error) !== genericErrorMessage(null)) {
        setFormError(genericErrorMessage(error));
        return;
      }

      setSent(true);
    });
  }

  if (sent) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MailCheck className="size-4 text-primary" aria-hidden />
            Check your email
          </CardTitle>
          <CardDescription>{PASSWORD_RESET_SENT}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/sign-in">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          We will email you a link to choose a new one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              disabled={pending}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? "email-error" : undefined}
            />
            {fieldErrors.email ? (
              <p id="email-error" className="text-xs text-destructive">
                {fieldErrors.email}
              </p>
            ) : null}
          </div>

          {formError ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {formError}
            </p>
          ) : null}

          <Button type="submit" disabled={pending} className="mt-1">
            {pending ? "Sending…" : "Send reset link"}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            <Link
              href="/sign-in"
              className="text-primary underline-offset-4 hover:underline"
            >
              Back to sign in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
