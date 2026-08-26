import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { OrderBuilder } from "@/app/(app)/orders/order-builder";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { loadCustomers, searchOrderProducts } from "@/server/orders";

export const metadata: Metadata = { title: "New order" };

// Stock levels and the product list are live, so this must not be captured at
// build time.
export const dynamic = "force-dynamic";

/**
 * The order creation page.
 *
 * A page rather than a dialog: building an order means searching a catalogue,
 * adding several lines and checking totals, which is more than a modal should
 * hold and is worth having a URL of its own.
 *
 * Both roles can raise an order — it is ordinary work. The server re-checks
 * authentication on every action regardless of what this page allowed.
 */
export default async function NewOrderPage() {
  const [customers, products] = await Promise.all([
    loadCustomers(),
    // A first page of products so the picker is useful before anyone types.
    searchOrderProducts("", 20),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href="/orders">
            <ArrowLeft />
            All orders
          </Link>
        </Button>

        <PageHeader
          title="New order"
          description="Pick a customer, add the parts being sold, and save it as a draft or confirm it straight away."
        />
      </div>

      <OrderBuilder customers={customers} initialProducts={products} />
    </div>
  );
}
