/**
 * Certificate status, derived — never stored.
 *
 * Same reasoning as stock status (src/lib/stock-status.ts), but with sharper
 * consequences: this one changes on its own. A certificate that is valid today
 * is expired tomorrow with nothing having been written, so a stored column
 * would be wrong every morning until something remembered to recalculate it.
 * Deriving it from the expiry date cannot go stale.
 *
 * The one rule worth stating up front: **absence of an expiry date is not a
 * problem.** A Certificate of Conformity typically never expires. Code that
 * treats a null expiry as suspicious — or worse, as expired — is wrong about a
 * large share of the documents in this table.
 */

export type CertificateStatus =
  | "MISSING"
  | "EXPIRED"
  | "EXPIRING_SOON"
  | "VALID";

/**
 * How far ahead counts as "approaching".
 *
 * Thirty days is the usual procurement lead time for recertifying or sourcing a
 * replacement part, which is the decision this warning exists to trigger. It is
 * a constant rather than a setting because nothing yet needs it to vary; when
 * something does, it becomes a parameter here and nowhere else.
 */
export const EXPIRING_SOON_DAYS = 30;

export interface CertificateExpiry {
  expiryDate: Date | string | null;
}

/**
 * Midnight UTC on the day a date falls, as a number.
 *
 * Expiry dates are stored in a `DATE` column — a calendar day, with no time and
 * no zone. Comparing one against `new Date()` directly would compare a day
 * against an instant, so a certificate expiring today would read as expired
 * from the moment the clock passed midnight in whatever zone the server
 * happened to be in. Reducing both sides to a UTC day makes "expires today"
 * mean the whole of today, everywhere.
 */
function toUtcDay(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
}

/**
 * The rules, in order:
 *
 *   MISSING        no certificate at all
 *   EXPIRED        expiryDate is before today
 *   EXPIRING_SOON  expiryDate is today, or within EXPIRING_SOON_DAYS
 *   VALID          everything else, including a certificate with no expiry
 *
 * `now` is injectable so the tests can ask what happens the day before an
 * expiry without waiting for it.
 */
export function certificateStatus(
  certificate: CertificateExpiry | null | undefined,
  now: Date = new Date(),
): CertificateStatus {
  if (!certificate) return "MISSING";

  // No expiry date means it does not expire. That is a complete answer, not a
  // missing one.
  if (certificate.expiryDate === null || certificate.expiryDate === undefined) {
    return "VALID";
  }

  const expiry = toUtcDay(certificate.expiryDate);
  const today = toUtcDay(now);

  if (expiry < today) return "EXPIRED";

  const daysRemaining = Math.round((expiry - today) / 86_400_000);
  return daysRemaining <= EXPIRING_SOON_DAYS ? "EXPIRING_SOON" : "VALID";
}

const LABELS: Record<CertificateStatus, string> = {
  MISSING: "No certificate",
  EXPIRED: "Expired",
  EXPIRING_SOON: "Expiring soon",
  VALID: "Valid",
};

export function certificateStatusLabel(status: CertificateStatus): string {
  return LABELS[status];
}
