import Link from "next/link";
import { PackageSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * A product id that does not resolve — a stale link, or an item deleted since
 * the page was last open.
 *
 * Its own boundary rather than the root one so the sidebar and header stay
 * mounted: the user keeps their navigation instead of being dropped onto a bare
 * page, and the way back to the catalogue is one click.
 */
export default function ProductNotFound() {
  return (
    <Card>
      <CardContent className="p-0">
        <EmptyState
          icon={PackageSearch}
          title="Product not found"
          description="This product does not exist. It may have been deleted, or the link may be out of date."
          action={
            <Button asChild>
              <Link href="/products">Back to products</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
