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
  signInErrorMessage,
  validateSignIn,
  type AuthFieldErrors,
} from "@/lib/validation/auth";

/**
 * Email and password, against Supabase Auth.
 *
 * ## Why `router.refresh()` and not just `push`
 *
 * `signInWithPassword` writes the session cookies from the browser. Navigating
 * alone would reach the server with React's cached copy of the previous render —
 * the one taken while nobody was signed in — and the `(app)` layout would redirect
 * straight back here. `refresh()` discards that cache so the next server render
 * reads the cookie that now exists. Refresh first, then navigate.
 *
 * ## Why every failure says the same thing
 *
 * The messages come from `lib/validation/auth`, which answers "wrong password"
 * and "no such account" identically. That is not vagueness for its own sake: a
 * form that distinguishes them tells anyone who asks which addresses have
 * accounts here. See that module for the full reasoning.
 */
export function SignInForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const result = validateSignIn({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });

    setFormError(null);

    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }

    setFieldErrors({});

    startTransition(async () => {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword(result.value);

      if (error) {
        setFormError(signInErrorMessage(error));
        return;
      }

      router.refresh();
      router.push("/dashboard");
    });
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Use the email address your account was created with.
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

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/forgot-password"
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              disabled={pending}
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={
                fieldErrors.password ? "password-error" : undefined
              }
            />
            {fieldErrors.password ? (
              <p id="password-error" className="text-xs text-destructive">
                {fieldErrors.password}
              </p>
            ) : null}
          </div>

          {formError ? (
            // `role="alert"` so the message is announced: a sighted user sees it
            // appear, and without this nobody else learns the attempt failed.
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {formError}
            </p>
          ) : null}

          <Button type="submit" disabled={pending} className="mt-1">
            {pending ? "Signing in…" : "Sign in"}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            No account yet?{" "}
            <Link
              href="/sign-up"
              className="text-primary underline-offset-4 hover:underline"
            >
              Create one
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
