import { AlertTriangle, CheckCircle2, PackageX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { stockStatusLabel, type StockStatus } from "@/lib/stock-status";

/**
 * The stock status pill, in one place.
 *
 * The status itself is always derived from the quantities (see
 * src/lib/stock-status.ts); this only decides how it looks. Colour alone would
 * leave the distinction invisible to anyone who cannot see the difference
 * between the amber and the red, so each state also carries its own icon and
 * its own words.
 */

const PRESENTATION: Record<
  StockStatus,
  { variant: "success" | "warning" | "destructive"; icon: typeof CheckCircle2 }
> = {
  NORMAL: { variant: "success", icon: CheckCircle2 },
  LOW_STOCK: { variant: "warning", icon: AlertTriangle },
  OUT_OF_STOCK: { variant: "destructive", icon: PackageX },
};

function StockStatusBadge({ status }: { status: StockStatus }) {
  const { variant, icon: Icon } = PRESENTATION[status];

  return (
    <Badge variant={variant}>
      <Icon aria-hidden />
      {stockStatusLabel(status)}
    </Badge>
  );
}

export { StockStatusBadge };
