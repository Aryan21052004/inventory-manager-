import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeftRight,
  Boxes,
  DatabaseZap,
  Layers,
  PackageX,
  ShoppingCart,
  Wallet,
} from "lucide-react";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCurrency,
  formatDateTime,
  formatDelta,
  formatNumber,
} from "@/lib/format";
import { loadDashboard, type DashboardSnapshot } from "@/server/dashboard";

export const metadata: Metadata = { title: "Dashboard" };

// The snapshot is live data, so this page must not be captured at build time.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const result = await loadDashboard();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="Stock health, open commitments, and recent movement across the warehouse."
      />

      {result.ok ? (
        <DashboardContent snapshot={result.data} />
      ) : (
        <DatabaseUnavailable message={result.error.message} />
      )}
    </div>
  );
}

function DashboardContent({ snapshot }: { snapshot: DashboardSnapshot }) {
  const hasStockAlerts =
    snapshot.lowStockCount > 0 || snapshot.outOfStockCount > 0;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Products"
          value={formatNumber(snapshot.productCount)}
          hint="Active items in the catalogue"
          icon={Boxes}
        />
        <StatCard
          label="Units on hand"
          value={formatNumber(snapshot.totalUnits)}
          hint="Across every active product"
          icon={Layers}
        />
        <StatCard
          label="Stock value"
          value={formatCurrency(snapshot.stockValue)}
          hint="Valued at unit cost"
          icon={Wallet}
          tone="success"
        />
        <StatCard
          label="Needs attention"
          value={formatNumber(
            snapshot.lowStockCount + snapshot.outOfStockCount,
          )}
          hint={`${snapshot.lowStockCount} low · ${snapshot.outOfStockCount} out of stock`}
          icon={hasStockAlerts ? AlertTriangle : PackageX}
          tone={hasStockAlerts ? "warning" : "default"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent stock movements</CardTitle>
            <CardDescription>
              Every change to stock on hand, and what caused it.
            </CardDescription>
            <CardAction>
              <Button variant="outline" size="sm" asChild>
                <Link href="/stock-movements">View all</Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="p-0">
            {snapshot.recentMovements.length === 0 ? (
              <EmptyState
                icon={ArrowLeftRight}
                title="No stock movements yet"
                description="Confirming an order or receiving a purchase writes a movement here automatically."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Change</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshot.recentMovements.map((movement) => (
                    <TableRow key={movement.id}>
                      <TableCell>
                        <span className="font-medium">
                          {movement.productName}
                        </span>
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {movement.productSku}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="muted">{movement.type}</Badge>
                      </TableCell>
                      <TableCell
                        className={`tabular text-right font-medium ${
                          movement.change < 0
                            ? "text-destructive"
                            : "text-success"
                        }`}
                      >
                        {formatDelta(movement.change)}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {formatNumber(movement.newStock)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatDateTime(movement.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Open commitments</CardTitle>
              <CardDescription>Work that will move stock.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <CommitmentRow
                icon={ShoppingCart}
                label="Orders awaiting fulfilment"
                value={snapshot.openOrderCount}
                href="/orders"
              />
              <CommitmentRow
                icon={Boxes}
                label="Purchases not yet received"
                value={snapshot.pendingPurchaseCount}
                href="/purchases"
              />
            </CardContent>
          </Card>

          <AutomaticStockExplainer />
        </div>
      </div>
    </>
  );
}

function CommitmentRow({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: typeof ShoppingCart;
  label: string;
  value: number;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-accent"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 text-sm">{label}</span>
      <span className="tabular text-lg font-semibold">
        {formatNumber(value)}
      </span>
    </Link>
  );
}

/**
 * States the core rule of the app in the place a new user will look first. It
 * is a description of intended behaviour — the engine itself is not built yet.
 */
function AutomaticStockExplainer() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>How stock stays current</CardTitle>
        <CardDescription>The rule the system will enforce.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Order confirmed
          </p>
          <p className="tabular mt-1 font-mono text-sm">
            200 − 150 <span className="text-muted-foreground">=</span>{" "}
            <span className="font-semibold text-destructive">50</span>
          </p>
        </div>
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Purchase received
          </p>
          <p className="tabular mt-1 font-mono text-sm">
            50 + 100 <span className="text-muted-foreground">=</span>{" "}
            <span className="font-semibold text-success">150</span>
          </p>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Each adjustment writes a stock movement in the same transaction, so
          the ledger always explains the balance.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Shown when Postgres cannot be reached — nearly always a missing database or
 * an unapplied migration on a fresh checkout, so it leads with the command that
 * fixes that rather than a bare error.
 */
function DatabaseUnavailable({ message }: { message: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseZap className="size-4 text-warning" aria-hidden />
          Database not reachable
        </CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">
          The app is running, but it has nothing to read yet. On a fresh
          checkout that usually means one of these:
        </p>
        <ol className="flex flex-col gap-3 text-muted-foreground">
          <li className="flex gap-3">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground">
              1
            </span>
            <span>
              PostgreSQL is not running, or{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                DATABASE_URL
              </code>{" "}
              in{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                .env.local
              </code>{" "}
              points somewhere else.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground">
              2
            </span>
            <span>
              The schema has not been created yet — run{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                npm run db:migrate
              </code>
              .
            </span>
          </li>
        </ol>
        <div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings">Check connection status</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
