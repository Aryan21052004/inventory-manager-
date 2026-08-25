import type { Metadata } from "next";
import { BarChart3, Download } from "lucide-react";

import { ModulePlaceholder } from "@/components/module-placeholder";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <ModulePlaceholder
      title="Reports"
      description="Valuation, movement, and sales reporting across any date range."
      icon={BarChart3}
      actions={
        <Button variant="outline" disabled>
          <Download />
          Export
        </Button>
      }
      planned={[
        "Stock valuation at cost and at retail",
        "Stock movement summary by type and period",
        "Sales by product, category, and customer",
        "Low-stock and dead-stock reports",
        "Purchase spend by supplier",
        "CSV export for every report",
      ]}
    />
  );
}
