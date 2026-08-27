import Link from "next/link";
import { PackageSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * A supplier id that does not resolve — a stale link, or a record deleted since
 * the page was last open.
 *
 * Its own boundary rather than the root one so the sidebar and header stay
 * mounted: the user keeps their navigation instead of being dropped onto a bare
 * page, and the way back to the directory is one click.
 */
export default function SupplierNotFound() {
  return (
    <Card>
      <CardContent className="p-0">
        <EmptyState
          icon={PackageSearch}
          title="Supplier not found"
          description="This supplier does not exist. They may have been deleted, or the link may be out of date."
          action={
            <Button asChild>
              <Link href="/suppliers">Back to suppliers</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
