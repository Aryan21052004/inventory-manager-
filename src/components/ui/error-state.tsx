"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The state a panel is in when loading it failed.
 *
 * `message` should already be safe to display — pass the output of
 * `toSafeError`, never a raw thrown error, so a Prisma or driver message cannot
 * end up on screen.
 */
function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  className,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center px-6 py-16 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/10">
        <AlertTriangle className="size-6 text-destructive" aria-hidden />
      </div>
      <h3 className="mt-4 text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-5" onClick={onRetry}>
          <RefreshCw />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export { ErrorState };
