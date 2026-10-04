"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { confirmCallbackUrl } from "@/lib/validation/auth-confirm";
import {
  CONFIRMATION_SENT,
  genericErrorMessage,
  MIN_PASSWORD_LENGTH,
  signUpOutcome,
  validateSignUp,
  type AuthFieldErrors,
} from "@/lib/validation/auth";

/**
 * Registration against Supabase Auth.
 *
 * ## The name goes in metadata; the role does not
 *
 * `options.data` becomes the Auth user's `user_metadata`, which the client can
 * set — so it can hold a display name and must never hold anything the server
 * trusts. A role in there would be a privilege the user grants themselves. The
 * application's role lives in `users.role` in our own database, is set to STAFF
 * by the server resolver on first sight of an account, and is read only by
 * `requireRole`.
 *
 * ## Why success looks the same whether or not the address was free
 *
 * With email confirmation on, registering an address that already has an account
 * returns a user with no identities rather than an error — Supabase's way of
 * refusing to confirm the address exists. `signUpOutcome` treats it as success,
 * so both cases land on the same "check your email" panel. Branching on it would
 * hand back the account-enumeration oracle Supabase just closed.
 */
export function SignUpForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmationSent, setConfirmationSent] = useState(false);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const result = validateSignUp({
      name: String(form.get("name") ?? ""),
      email: String(form.get("email") ?? ""),
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
      const { data, error } = await supabase.auth.signUp({
        email: result.value.email,
        password: result.value.password,
        options: {
          /*
           * Where the confirmation link comes back to. Without this the link
           * returns to the project's Site URL, which in this application
           * redirects to /dashboard and drops the query string on the way — so
           * the confirmation would be silently lost.
           */
          emailRedirectTo: confirmCallbackUrl(window.location.origin),
          // A display name, nothing more. See the note above.
          data: { full_name: result.value.name },
        },
      });

      if (error) {
        setFormError(genericErrorMessage(error));
        return;
      }

      if (signUpOutcome(data) === "confirmation-required") {
        setConfirmationSent(true);
        return;
      }

      router.refresh();
      router.push("/dashboard");
    });
  }

  if (confirmationSent) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MailCheck className="size-4 text-primary" aria-hidden />
            Check your email
          </CardTitle>
          <CardDescription>{CONFIRMATION_SENT}</CardDescription>
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
        <CardTitle>Create an account</CardTitle>
        <CardDescription>
          New accounts start with standard access. An administrator can change
          that afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              autoFocus
              disabled={pending}
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? "name-error" : undefined}
            />
            {fieldErrors.name ? (
              <p id="name-error" className="text-xs text-destructive">
                {fieldErrors.name}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
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

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
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
            <Label htmlFor="confirmPassword">Confirm password</Label>
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
              {formError}
            </p>
          ) : null}

          <Button type="submit" disabled={pending} className="mt-1">
            {pending ? "Creating account…" : "Create account"}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Already have an account?{" "}
            <Link
              href="/sign-in"
              className="text-primary underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
