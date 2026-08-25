import Link from "next/link";
import { FileQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/60">
        <FileQuestion className="size-6 text-muted-foreground" aria-hidden />
      </div>
      <h1 className="mt-5 text-lg font-semibold">Page not found</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        That page does not exist, or it has moved somewhere else.
      </p>
      <Button asChild className="mt-6">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
