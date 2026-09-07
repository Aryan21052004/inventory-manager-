import Link from "next/link";
import { PackageOpen, ShieldAlert } from "lucide-react";

import { LotActions } from "@/app/(app)/lots/lot-actions";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import { getCurrentUser } from "@/server/auth";
import { listQuarantinedLots } from "@/server/lots";

export const metadata = { title: "Returned stock" };

/**
 * Returned batches waiting for somebody to look at them.
 *
 * This page exists because of a deliberate absence elsewhere: there is no
 * quarantine duration and no automatic release, since different parts warrant
 * different inspections and nothing here can know which. That policy is only
 * safe while the waiting batches are *visible* — otherwise a batch nobody got
 * to would sit out of sale for ever with no screen ever mentioning it.
 *
 * So it is a queue, ordered oldest first, showing how long each batch has been
 * held. The ageing column is the point of the page rather than decoration.
 *
 * ADMIN-only, and not because of what it displays — `listQuarantinedLots`
 * enforces that on the server, as do all three actions the rows offer.
 *
 * The role is read here as well, and only to choose what to render. Every other
 * ADMIN gate in this application sits on a mutation, so it stays invisible until
 * somebody tries to change something; this is the first on a *page*, and the
 * sidebar offers it to everyone. Without the check below a member of staff
 * following their own navigation lands on the generic error boundary — "this
 * page could not be loaded" — which describes a fault rather than a permission,
 * and would be reported as a bug. The server refusal is what actually protects
 * the data and is deliberately left in place underneath.
 */
export default async function ReturnsPage() {
  const user = await getCurrentUser();

  if (user?.role !== "ADMIN") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Returned stock"
          description="Batches a customer sent back, waiting on inspection."
        />

        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={ShieldAlert}
              title="Admin access required"
              description="Deciding whether returned stock goes back on sale or is condemned is restricted to administrators. Ask one to review the queue — the batches are counted as stock in the meantime, and cannot be sold until somebody releases them."
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const lots = await listQuarantinedLots();

  const units = lots.reduce((sum, lot) => sum + lot.quantityRemaining, 0);
  const oldest = lots[0]?.daysHeld ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Returned stock"
        description="Batches a customer sent back, waiting on inspection. They are on the shelf and counted, but cannot be sold until somebody releases them."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Awaiting inspection</CardDescription>
            <CardTitle className="tabular text-3xl">
              {formatNumber(lots.length)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {lots.length === 1 ? "batch" : "batches"}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Units held</CardDescription>
            <CardTitle className="tabular text-3xl">
              {formatNumber(units)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            counted as stock, not saleable
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Longest wait</CardDescription>
            <CardTitle className="tabular text-3xl">
              {formatNumber(oldest)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {oldest === 1 ? "day" : "days"}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Quarantine queue</CardTitle>
          <CardDescription>
            Oldest first. Releasing records a physical inspection only — it does
            not attach or revalidate a certificate.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {lots.length === 0 ? (
            <EmptyState
              icon={PackageOpen}
              title="Nothing awaiting inspection"
              description="Batches appear here when a customer return is recorded against an order."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Came back on</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead className="text-right">Held</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="w-px text-right">
                    <span className="sr-only">Batch actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lots.map((lot) => (
                  <TableRow key={lot.lotId}>
                    <TableCell>
                      <Link
                        href={`/products/${lot.productId}`}
                        className="font-medium hover:text-primary hover:underline"
                      >
                        {lot.productName}
                      </Link>
                      <p className="font-mono text-xs text-muted-foreground">
                        {lot.sku}
                      </p>
                    </TableCell>
                    <TableCell className="text-sm">
                      {lot.returnNumber ? (
                        <span className="font-mono text-xs">{lot.returnNumber}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {lot.orderNumber ? (
                        <p className="text-xs text-muted-foreground">
                          {lot.orderNumber}
                          {lot.customerName ? ` · ${lot.customerName}` : ""}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDate(lot.receivedAt)}
                    </TableCell>
                    <TableCell className="tabular text-right text-sm">
                      {lot.daysHeld === 0
                        ? "today"
                        : `${formatNumber(lot.daysHeld)}d`}
                    </TableCell>
                    <TableCell className="tabular text-right text-sm">
                      {formatNumber(lot.quantityRemaining)}
                    </TableCell>
                    <TableCell className="tabular text-right text-sm">
                      {lot.unitCost === null ? (
                        <span className="text-muted-foreground">Unknown</span>
                      ) : (
                        formatCurrency(
                          Number(lot.unitCost) * lot.quantityRemaining,
                        )
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <LotActions
                        lot={{
                          lotId: lot.lotId,
                          productName: lot.productName,
                          status: lot.status,
                          quantityRemaining: lot.quantityRemaining,
                          unitCost: lot.unitCost,
                          isReturn: lot.isReturn,
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="max-w-prose text-sm text-muted-foreground">
        A rejected batch stays on the shelf and keeps its cost until it is
        written off. Write-offs are done from the batch table on the product
        page, where the remaining quantity is shown alongside.{" "}
        <Badge variant="outline">Admin only</Badge>
      </p>
    </div>
  );
}
