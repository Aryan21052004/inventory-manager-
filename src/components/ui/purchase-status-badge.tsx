import { CircleDashed, PackageCheck, Truck, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { purchaseStatusLabel, type PurchaseStatus } from "@/lib/purchase-status";

/**
 * The purchase status pill.
 *
 * Icons as well as colour, so the four states stay distinguishable without
 * relying on hue. PENDING gets the lorry: it is the one that means "placed with
 * the supplier and on its way", which is the distinction people most often need
 * from a draft.
 */

const PRESENTATION: Record<
  PurchaseStatus,
  {
    variant: "muted" | "secondary" | "success" | "destructive";
    icon: typeof PackageCheck;
  }
> = {
  DRAFT: { variant: "muted", icon: CircleDashed },
  PENDING: { variant: "secondary", icon: Truck },
  RECEIVED: { variant: "success", icon: PackageCheck },
  CANCELLED: { variant: "destructive", icon: XCircle },
};

function PurchaseStatusBadge({ status }: { status: PurchaseStatus }) {
  const { variant, icon: Icon } = PRESENTATION[status];

  return (
    <Badge variant={variant}>
      <Icon aria-hidden />
      {purchaseStatusLabel(status)}
    </Badge>
  );
}

export { PurchaseStatusBadge };
