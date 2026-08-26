import { AlertTriangle, CircleSlash, Clock, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  certificateStatusLabel,
  type CertificateStatus,
} from "@/lib/certificate-status";

/**
 * The certificate status pill.
 *
 * Four states rather than three, because "no certificate" and "expired
 * certificate" are different problems with different fixes — one needs
 * paperwork chasing, the other needs recertification — and collapsing them into
 * a single red badge would hide which.
 *
 * As with stock status, each state carries an icon and words as well as a
 * colour, so the distinction survives for anyone who cannot separate the amber
 * from the red.
 */

const PRESENTATION: Record<
  CertificateStatus,
  {
    variant: "success" | "warning" | "destructive" | "muted";
    icon: typeof ShieldCheck;
  }
> = {
  VALID: { variant: "success", icon: ShieldCheck },
  EXPIRING_SOON: { variant: "warning", icon: Clock },
  EXPIRED: { variant: "destructive", icon: AlertTriangle },
  MISSING: { variant: "muted", icon: CircleSlash },
};

function CertificateStatusBadge({ status }: { status: CertificateStatus }) {
  const { variant, icon: Icon } = PRESENTATION[status];

  return (
    <Badge variant={variant}>
      <Icon aria-hidden />
      {certificateStatusLabel(status)}
    </Badge>
  );
}

export { CertificateStatusBadge };
