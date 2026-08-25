import { Card, CardContent } from "@/components/ui/card";
import { Skeleton, StatCardSkeleton, TableSkeleton } from "@/components/ui/skeleton";

/**
 * Shown while a page inside the shell streams in.
 *
 * Shaped like the pages it stands in for — a header, a row of tiles, a table —
 * so the layout does not jump when the real content arrives.
 */
export default function AppLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <TableSkeleton rows={6} columns={5} />
        </CardContent>
      </Card>
    </div>
  );
}
