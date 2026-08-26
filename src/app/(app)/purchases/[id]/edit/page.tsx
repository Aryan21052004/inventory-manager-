import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Lock } from "lucide-react";

import { PurchaseBuilder } from "@/app/(app)/purchases/purchase-builder";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { PurchaseStatusBadge } from "@/components/ui/purchase-status-badge";
import { isEditable, purchaseStatusLabel } from "@/lib/purchase-status";
import {
  getPurchaseDetail,
  loadPurchaseProducts,
  loadSupplierOptions,
  searchPurchaseProducts,
} from "@/server/purchases";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const result = await getPurchaseDetail((await params).id);

  return {
    title:
      result.ok && result.data
        ? `Edit ${result.data.purchaseNumber}`
        : "Edit purchase",
  };
}

/**
 * Editing a purchase's lines, supplier and date.
 *
 * The same builder the create page uses. Editing never touches inventory —
 * `updatePurchase` writes lines and money and has no path to the stock engine;
 * quantities move only on receipt. The status check below is so a person sees a
 * sentence instead of a form that will refuse them; `updatePurchase` re-checks
 * it inside the transaction with the purchase row locked.
 */
export default async function EditPurchasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getPurchaseDetail(id);

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="p-0">
          <ErrorState
            title="This purchase could not be loaded"
            message={result.error.message}
          />
        </CardContent>
      </Card>
    );
  }

  if (!result.data) notFound();

  const purchase = result.data;

  if (!isEditable(purchase.status)) {
    return <NotEditable purchaseId={purchase.id} status={purchase.status} />;
  }

  /*
   * Line products are loaded by id and without a status filter, so a line whose
   * product was retired since still appears. Dropping it here would make it
   * vanish from the form and silently disappear from the purchase on save.
   */
  const [suppliers, searchResults, lineProducts] = await Promise.all([
    loadSupplierOptions(),
    searchPurchaseProducts("", 20),
    loadPurchaseProducts(purchase.lines.map((line) => line.productId)),
  ]);

  const byId = new Map(lineProducts.map((product) => [product.id, product]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href={`/purchases/${purchase.id}`}>
            <ArrowLeft />
            Back to {purchase.purchaseNumber}
          </Link>
        </Button>

        <PageHeader
          title={`Edit ${purchase.purchaseNumber}`}
          description="Change the supplier, date or lines. The total is recalculated when you save, and inventory is untouched until the delivery is received."
          actions={<PurchaseStatusBadge status={purchase.status} />}
        />
      </div>

      <PurchaseBuilder
        suppliers={suppliers}
        initialProducts={searchResults}
        purchase={{
          id: purchase.id,
          purchaseNumber: purchase.purchaseNumber,
          supplierId: purchase.supplier.id,
          purchaseDate: purchase.purchaseDate.toISOString().slice(0, 10),
          lines: purchase.lines.flatMap((line) => {
            const product = byId.get(line.productId);
            return product
              ? [
                  {
                    product,
                    quantity: line.quantity,
                    // The cost already recorded on the line — the supplier's
                    // number for this delivery, not the catalogue's.
                    unitCost: line.unitCost,
                  },
                ]
              : [];
          }),
        }}
      />
    </div>
  );
}

function NotEditable({
  purchaseId,
  status,
}: {
  purchaseId: string;
  status: Parameters<typeof purchaseStatusLabel>[0];
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <EmptyState
          icon={Lock}
          title={`This purchase is ${purchaseStatusLabel(status).toLowerCase()} and cannot be edited`}
          description={
            status === "CANCELLED"
              ? "A cancelled purchase is a record of a delivery that did not stand. Raise a new purchase instead."
              : "Its goods have already been booked into stock, so its lines are fixed — changing them would leave the document and the inventory disagreeing."
          }
          action={
            <Button asChild>
              <Link href={`/purchases/${purchaseId}`}>Back to the purchase</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
