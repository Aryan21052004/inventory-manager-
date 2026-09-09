import Link from "next/link";
import { Boxes } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Wordmark used in the sidebar and the mobile drawer. Links home so the logo
 * behaves the way every user expects a logo to behave.
 */
function Brand({
  appName,
  className,
}: {
  appName: string;
  className?: string;
}) {
  return (
    <Link
      href="/dashboard"
      className={cn(
        "flex items-center gap-2.5 rounded-md px-1 py-1 transition-opacity hover:opacity-80",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Boxes className="size-[18px]" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold leading-tight">
          {appName}
        </span>
        <span className="block text-[11px] leading-tight text-muted-foreground">
          Stock control
        </span>
      </span>
    </Link>
  );
}

export { Brand };
