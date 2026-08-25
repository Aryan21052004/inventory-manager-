"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Route-level error boundary for every page inside the shell.
 *
 * The sidebar and header stay mounted because this boundary sits inside the
 * layout — the user keeps their navigation instead of being dropped onto a bare
 * error page.
 *
 * Next passes the real error object here, but in production its message is
 * replaced with a generic one and only `digest` survives, so the digest is what
 * we surface for matching against server logs.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[inventory-manager] route error:", error);
  }, [error]);

  return (
    <Card>
      <CardContent className="p-0">
        <ErrorState
          title="This page could not be loaded"
          message={
            error.digest
              ? `Something went wrong while loading this section. Reference: ${error.digest}`
              : "Something went wrong while loading this section. Try again, and check the server logs if it keeps happening."
          }
          onRetry={reset}
        />
      </CardContent>
    </Card>
  );
}
