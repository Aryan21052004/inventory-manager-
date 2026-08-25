import Link from "next/link";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Stands in for Clerk's sign-in and sign-up widgets while the keys are missing.
 *
 * Clerk's components throw without a publishable key, which would turn a
 * half-finished setup into a stack trace. This says what is missing instead.
 */
function AuthSetupNotice({ action }: { action: string }) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-warning" aria-hidden />
          Authentication not configured
        </CardTitle>
        <CardDescription>
          You cannot {action} until Clerk is set up for this environment.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">
          Create an application at{" "}
          <a
            href="https://dashboard.clerk.com"
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline-offset-4 hover:underline"
          >
            dashboard.clerk.com
          </a>
          , then add both keys to{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            .env.local
          </code>{" "}
          and restart the dev server.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs">
          {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…\nCLERK_SECRET_KEY=sk_test_…"}
        </pre>
        <Button asChild variant="outline" className="self-start">
          <Link href="/dashboard">Continue without signing in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export { AuthSetupNotice };
