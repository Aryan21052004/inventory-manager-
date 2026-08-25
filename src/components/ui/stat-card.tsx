import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type Tone = "default" | "success" | "warning" | "destructive";

const TONE_CLASSES: Record<Tone, string> = {
  default: "bg-primary/10 text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-warning/15 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

/**
 * A single figure on the dashboard.
 *
 * The value uses tabular figures so a row of tiles lines up on the decimal
 * point rather than drifting with the digits.
 */
function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-6 shadow-sm transition-shadow hover:shadow-md",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg",
            TONE_CLASSES[tone],
          )}
        >
          <Icon className="size-4" aria-hidden />
        </div>
      </div>
      <p className="tabular mt-4 text-2xl font-semibold tracking-tight">
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export { StatCard };
