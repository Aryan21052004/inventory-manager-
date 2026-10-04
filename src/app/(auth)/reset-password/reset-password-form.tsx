"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

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
  genericErrorMessage,
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
  type AuthFieldErrors,
} from "@/lib/validation/auth";

/**
 * Chooses a replacement password, having arrived from a recovery link.
 *
 * ## No token is read, parsed or displayed here
 *
 * The recovery link carries a code which `@supabase/ssr` exchanges for a
 * session on arrival — the browser client is configured for the PKCE flow and
 * does that itself. By the time this form submits there is simply a session, so
 * `updateUser` needs nothing but the new password. Reading the token out of the
 * URL by hand would mean reimplementing the exchange, and putting it on screen
 * would leak a credential into screenshots, scroll-back and support tickets.
 *
 * If the link has expired the session will not exist and `updateUser` fails; the
 * user is told to request another rather than shown the provider's wording.
 *
 * ## Signing out afterwards is deliberate
 *
 * A password change is the moment to prove the new one works. The local session
 * is ended and the user returns to sign-in — which also means a shared or
 * borrowed machine is not left holding an authenticated session established by
 * an emailed link. `scope: "local"` so their other devices are not disturbed;
 * Supabase already revokes other sessions on a password change if the project is
 * configured to.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const result = validateNewPassword({
      password: String(form.get("password") ?? ""),
      confirmPassword: String(form.get("confirmPassword") ?? ""),
    });

    setFormError(null);

    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }

    setFieldErrors({});

    startTransition(async () => {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.updateUser({
        password: result.value.password,
      });

      if (error) {
        setFormError(genericErrorMessage(error));
        return;
      }

      await supabase.auth.signOut({ scope: "local" });

      router.refresh();
      router.push("/sign-in?reset=done");
    });
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          You will be asked to sign in again with it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              autoFocus
              disabled={pending}
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={
                fieldErrors.password ? "password-error" : "password-hint"
              }
            />
            {fieldErrors.password ? (
              <p id="password-error" className="text-xs text-destructive">
                {fieldErrors.password}
              </p>
            ) : (
              <p id="password-hint" className="text-xs text-muted-foreground">
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              disabled={pending}
              aria-invalid={Boolean(fieldErrors.confirmPassword)}
              aria-describedby={
                fieldErrors.confirmPassword ? "confirm-error" : undefined
              }
            />
            {fieldErrors.confirmPassword ? (
              <p id="confirm-error" className="text-xs text-destructive">
                {fieldErrors.confirmPassword}
              </p>
            ) : null}
          </div>

          {formError ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {formError} If the link in your email has expired, request a new
              one.
            </p>
          ) : null}

          <Button type="submit" disabled={pending} className="mt-1">
            {pending ? "Saving…" : "Save new password"}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            <Link
              href="/forgot-password"
              className="text-primary underline-offset-4 hover:underline"
            >
              Request a new link
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
