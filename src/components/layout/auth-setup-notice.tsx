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
 * Stands in for the authentication screens while the Supabase keys are missing.
 *
 * The forms cannot build a client without a project URL and publishable key,
 * which would turn a half-finished setup into a stack trace. This says what is
 * missing instead.
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
          You cannot {action} until Supabase Auth is set up for this environment.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">
          Open your project’s API settings at{" "}
          <a
            href="https://supabase.com/dashboard"
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline-offset-4 hover:underline"
          >
            supabase.com/dashboard
          </a>
          , then add both values to{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            .env.local
          </code>{" "}
          and restart the dev server.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs">
          {"NEXT_PUBLIC_SUPABASE_URL=https://….supabase.co\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=…"}
        </pre>
        <Button asChild variant="outline" className="self-start">
          <Link href="/dashboard">Continue without signing in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export { AuthSetupNotice };
