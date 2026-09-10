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
  compact = false,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone?: Tone;
  /**
   * A denser tile, for a screen that shows many at once.
   *
   * Opt-in, and deliberately so: the dashboard carries eighteen of these and
   * reads as a wall, while a page showing four wants the room. Every caller
   * that does not ask for it renders exactly as it did before.
   *
   * Only the geometry changes — padding, the value's size and the icon well.
   * The label, the hint, the tones and the border stay put, so a compact tile
   * and a default one are recognisably the same object.
   */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md",
        compact ? "p-4" : "p-6",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <div
          className={cn(
            "flex shrink-0 items-center justify-center rounded-lg",
            compact ? "size-7" : "size-8",
            TONE_CLASSES[tone],
          )}
        >
          <Icon className={compact ? "size-3.5" : "size-4"} aria-hidden />
        </div>
      </div>
      <p
        className={cn(
          "tabular font-semibold tracking-tight",
          compact ? "mt-2.5 text-xl" : "mt-4 text-2xl",
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export { StatCard };
