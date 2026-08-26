import Link from "next/link";
import { ShoppingCart } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * An order id that does not resolve — a stale link, or a draft deleted since
 * the page was last open. Its own boundary so the shell stays mounted and the
 * way back is one click.
 */
export default function OrderNotFound() {
  return (
    <Card>
      <CardContent className="p-0">
        <EmptyState
          icon={ShoppingCart}
          title="Order not found"
          description="This order does not exist. It may have been removed, or the link may be out of date."
          action={
            <Button asChild>
              <Link href="/orders">Back to orders</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
