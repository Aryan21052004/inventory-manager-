import Link from "next/link";
import { Warehouse } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * A purchase id that does not resolve — a stale link, or a draft removed since
 * the page was last open. Its own boundary so the shell stays mounted.
 */
export default function PurchaseNotFound() {
  return (
    <Card>
      <CardContent className="p-0">
        <EmptyState
          icon={Warehouse}
          title="Purchase not found"
          description="This purchase does not exist. It may have been removed, or the link may be out of date."
          action={
            <Button asChild>
              <Link href="/purchases">Back to purchases</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
