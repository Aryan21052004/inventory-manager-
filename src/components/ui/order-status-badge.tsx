import {
  CheckCircle2,
  CircleDashed,
  Clock,
  PackageCheck,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { orderStatusLabel, type OrderStatus } from "@/lib/order-status";

/**
 * The order status pill.
 *
 * Icons as well as colour, so the five states stay distinguishable for anyone
 * who cannot separate them by hue — and because CONFIRMED and COMPLETED are the
 * pair most worth telling apart at a glance: one is a commitment with stock
 * already deducted, the other is goods that have shipped.
 */

const PRESENTATION: Record<
  OrderStatus,
  {
    variant: "muted" | "secondary" | "default" | "success" | "destructive";
    icon: typeof CheckCircle2;
  }
> = {
  DRAFT: { variant: "muted", icon: CircleDashed },
  PENDING: { variant: "secondary", icon: Clock },
  CONFIRMED: { variant: "default", icon: CheckCircle2 },
  COMPLETED: { variant: "success", icon: PackageCheck },
  CANCELLED: { variant: "destructive", icon: XCircle },
};

function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const { variant, icon: Icon } = PRESENTATION[status];

  return (
    <Badge variant={variant}>
      <Icon aria-hidden />
      {orderStatusLabel(status)}
    </Badge>
  );
}

export { OrderStatusBadge };
