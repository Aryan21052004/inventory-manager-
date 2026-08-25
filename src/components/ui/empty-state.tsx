import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The state a list is in before anything exists in it.
 *
 * Deliberately not a shrug — an empty state names what would go here and offers
 * the action that creates the first one, so a new workspace has an obvious next
 * step rather than a blank panel.
 */
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-16 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/60">
        <Icon className="size-6 text-muted-foreground" aria-hidden />
      </div>
      <h3 className="mt-4 text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {description}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
