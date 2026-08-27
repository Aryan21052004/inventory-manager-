import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { PurchaseBuilder } from "@/app/(app)/purchases/purchase-builder";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { searchPurchaseProducts } from "@/server/purchases";
import { loadSupplierOptions } from "@/server/suppliers";

export const metadata: Metadata = { title: "New purchase" };

// Stock levels and the product list are live, so this must not be captured at
// build time.
export const dynamic = "force-dynamic";

/**
 * The purchase creation page.
 *
 * A page rather than a dialog: entering a delivery note means searching a
 * catalogue, adding several lines with their own costs, and checking a total —
 * more than a modal should hold, and worth a URL of its own.
 */
export default async function NewPurchasePage() {
  const [suppliers, products] = await Promise.all([
    loadSupplierOptions(),
    // A first page of products so the picker is useful before anyone types.
    searchPurchaseProducts("", 20),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href="/purchases">
            <ArrowLeft />
            All purchases
          </Link>
        </Button>

        <PageHeader
          title="New purchase"
          description="Pick a supplier, add the parts being delivered with what they cost, and save it as a draft or receive it straight away."
        />
      </div>

      <PurchaseBuilder suppliers={suppliers} initialProducts={products} />
    </div>
  );
}
