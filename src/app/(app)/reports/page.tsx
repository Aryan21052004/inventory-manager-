import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  ShoppingCart,
  Truck,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { REPORT_DESCRIPTIONS, REPORT_TITLES } from "@/lib/report-query";

export const metadata: Metadata = { title: "Reports" };

/**
 * The report index.
 *
 * Four reports in this version. The catalogue beyond them is documented in
 * HANDOVER.md rather than listed here as disabled cards — a page of things you
 * cannot click is a worse answer than a short page of things you can.
 */

const REPORTS = [
  { key: "valuation", icon: Boxes, href: "/reports/valuation" },
  { key: "sales", icon: ShoppingCart, href: "/reports/sales" },
  { key: "purchases", icon: Truck, href: "/reports/purchases" },
  { key: "movements", icon: ArrowLeftRight, href: "/reports/movements" },
] as const;

export default function ReportsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Stock valuation, sales, procurement and stock movement, over any period, exportable as CSV."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {REPORTS.map(({ key, icon: Icon, href }) => (
          <Link
            key={key}
            href={href}
            className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Card className="h-full transition-shadow hover:shadow-md">
              <CardHeader>
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-4" aria-hidden />
                </span>
                <CardTitle className="mt-3">{REPORT_TITLES[key]}</CardTitle>
                <CardDescription>{REPORT_DESCRIPTIONS[key]}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="size-4 text-muted-foreground" aria-hidden />
            How these figures are defined
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">
              Dates are the economic event.
            </span>{" "}
            Sales are dated by when an order was confirmed — the moment stock
            left — and procurement by when a delivery was received. An order
            raised in March and confirmed in June is June&apos;s business.
          </p>
          <p>
            <span className="font-medium text-foreground">
              Only what actually happened counts.
            </span>{" "}
            Confirmed and completed orders are revenue; received purchases are
            spend. Drafts and cancellations are neither.
          </p>
          <p>
            <span className="font-medium text-foreground">
              Unknown cost stays unknown.
            </span>{" "}
            Stock with no recorded acquisition cost is excluded from value and
            counted separately — never valued at zero, and never at the
            catalogue&apos;s standard cost.
          </p>
          <p>
            <span className="font-medium text-foreground">
              No profitability figure yet.
            </span>{" "}
            Cost of sales is recorded from the point FIFO costing began, and
            orders confirmed before then have none. A margin over that history
            would be an invention, so these reports do not offer one.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
