import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

/**
 * Placeholder shaped like the table it replaces.
 *
 * A skeleton that matches the real layout stops the page shifting when data
 * lands — the rows are already the right height and the columns the right
 * count, so content fills in rather than pushing things around.
 */
function TableSkeleton({
  rows = 6,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="w-full">
      <div className="flex h-10 items-center gap-4 border-b border-border bg-muted/40 px-4">
        {Array.from({ length: columns }).map((_, index) => (
          <Skeleton key={index} className="h-3 flex-1 bg-muted-foreground/20" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          key={rowIndex}
          className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-0"
        >
          {Array.from({ length: columns }).map((_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className="h-4 flex-1"
              // Slight width variation keeps it from looking like a barcode.
              style={{ maxWidth: columnIndex === 0 ? "none" : "6rem" }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Mirrors `StatCard`, including its opt-in compact geometry, so the page does
 *  not resize when the real figures arrive. */
function StatCardSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card shadow-sm",
        compact ? "p-4" : "p-6",
      )}
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-24" />
        <Skeleton className={cn("rounded-lg", compact ? "size-7" : "size-8")} />
      </div>
      <Skeleton className={compact ? "mt-2.5 h-7 w-28" : "mt-4 h-8 w-32"} />
      <Skeleton className="mt-2 h-3 w-20" />
    </div>
  );
}

export { Skeleton, TableSkeleton, StatCardSkeleton };
