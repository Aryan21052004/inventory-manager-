import Link from "next/link";
import { UserRoundSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * A customer id that does not resolve — a stale link, or a record deleted since
 * the page was last open.
 *
 * Its own boundary rather than the root one so the sidebar and header stay
 * mounted: the user keeps their navigation instead of being dropped onto a bare
 * page, and the way back to the directory is one click.
 */
export default function CustomerNotFound() {
  return (
    <Card>
      <CardContent className="p-0">
        <EmptyState
          icon={UserRoundSearch}
          title="Customer not found"
          description="This customer does not exist. They may have been deleted, or the link may be out of date."
          action={
            <Button asChild>
              <Link href="/customers">Back to customers</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
