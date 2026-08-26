"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Download,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { removeCertificateAction } from "@/app/(app)/products/actions";
import {
  CertificateFormDialog,
  type CertificateFormMode,
} from "@/app/(app)/products/[id]/certificate-form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CertificateStatusBadge } from "@/components/ui/certificate-status-badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CertificateStatus } from "@/lib/certificate-status";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatFileSize } from "@/lib/validation/certificate";

/**
 * The certificate section of a product's detail page.
 *
 * A client component because of the dialogs it owns, but it renders data
 * prepared on the server — including the status, which is derived there from
 * the expiry date rather than recomputed in the browser, so the badge cannot
 * disagree with what a report would say.
 *
 * `canManage` hides the admin actions and, as everywhere in this application,
 * hides is all it does: each action re-checks the ADMIN role on the server. The
 * View and Download links are shown to everyone signed in, because reading the
 * paperwork is part of the job — the route behind them requires a session, not
 * a role.
 */

export interface CertificatePanelData {
  id: string;
  certificateType: string;
  certificateNumber: string;
  /** `YYYY-MM-DD`, ready for a date input and for display. */
  issueDate: string;
  expiryDate: string | null;
  fileName: string;
  fileSize: number;
  fileUrl: string;
  uploadedByName: string | null;
  createdAt: string;
}

export interface CertificateHistoryEntry {
  id: string;
  certificateType: string;
  certificateNumber: string;
  issueDate: string;
  expiryDate: string | null;
  fileName: string;
  fileUrl: string;
  supersededAt: string;
  uploadedByName: string | null;
}

function CertificatePanel({
  productId,
  certificate,
  status,
  history,
  canManage,
}: {
  productId: string;
  certificate: CertificatePanelData | null;
  status: CertificateStatus;
  history: CertificateHistoryEntry[];
  canManage: boolean;
}) {
  const [formMode, setFormMode] = useState<CertificateFormMode | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2.5">
            Certificate
            <CertificateStatusBadge status={status} />
          </CardTitle>
          <CardDescription>
            Airworthiness and conformity paperwork for this part.
          </CardDescription>
          {canManage ? (
            <CardAction>
              {certificate ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFormMode("edit")}
                  >
                    <Pencil />
                    <span className="hidden sm:inline">Edit details</span>
                  </Button>
                  <Button size="sm" onClick={() => setFormMode("replace")}>
                    <RefreshCw />
                    <span className="hidden sm:inline">Replace</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Withdraw certificate"
                    onClick={() => setWithdrawing(true)}
                  >
                    <Trash2 className="text-destructive" />
                  </Button>
                </div>
              ) : (
                <Button size="sm" onClick={() => setFormMode("add")}>
                  <Plus />
                  Add certificate
                </Button>
              )}
            </CardAction>
          ) : null}
        </CardHeader>

        <CardContent className={certificate ? undefined : "p-0"}>
          {certificate ? (
            <CertificateDetails certificate={certificate} status={status} />
          ) : (
            <EmptyState
              icon={ShieldOff}
              title="No certificate on file"
              description={
                canManage
                  ? "This part has no airworthiness or conformity document recorded. Add one when the paperwork arrives — a product can exist without it."
                  : "This part has no certificate recorded. An administrator can upload one."
              }
            />
          )}
        </CardContent>
      </Card>

      {history.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Certificate history</CardTitle>
            <CardDescription>
              Documents this part was previously covered by. Retired rather than
              deleted — each one is still readable.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead className="hidden sm:table-cell">Issued</TableHead>
                  <TableHead className="hidden md:table-cell">Expiry</TableHead>
                  <TableHead>Retired</TableHead>
                  <TableHead className="text-right">File</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <Badge variant="outline">{entry.certificateType}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {entry.certificateNumber}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {formatDate(entry.issueDate)}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {entry.expiryDate ? formatDate(entry.expiryDate) : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(entry.supersededAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <a
                          href={entry.fileUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Eye />
                          View
                        </a>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {canManage ? (
        <>
          <CertificateFormDialog
            open={formMode !== null}
            onOpenChange={(next) => setFormMode(next ? formMode : null)}
            mode={formMode ?? "add"}
            productId={productId}
            certificate={
              certificate
                ? {
                    id: certificate.id,
                    certificateType: certificate.certificateType,
                    certificateNumber: certificate.certificateNumber,
                    issueDate: certificate.issueDate,
                    expiryDate: certificate.expiryDate ?? "",
                  }
                : undefined
            }
          />

          {certificate ? (
            <WithdrawCertificateDialog
              open={withdrawing}
              onOpenChange={setWithdrawing}
              certificate={certificate}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function CertificateDetails({
  certificate,
  status,
}: {
  certificate: CertificatePanelData;
  status: CertificateStatus;
}) {
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        <DetailItem label="Certificate type">
          <Badge variant="outline">{certificate.certificateType}</Badge>
        </DetailItem>

        <DetailItem label="Certificate number">
          <span className="font-mono text-sm">
            {certificate.certificateNumber}
          </span>
        </DetailItem>

        <DetailItem label="Issue date">
          <span className="text-sm">{formatDate(certificate.issueDate)}</span>
        </DetailItem>

        <DetailItem label="Expiry date">
          {certificate.expiryDate ? (
            <span
              className={`text-sm ${status === "EXPIRED" ? "font-medium text-destructive" : status === "EXPIRING_SOON" ? "font-medium text-warning" : ""}`}
            >
              {formatDate(certificate.expiryDate)}
            </span>
          ) : (
            // Not a gap in the record. Plenty of certificates never expire, and
            // saying so is clearer than an em dash the reader has to interpret.
            <span className="text-sm text-muted-foreground">
              Does not expire
            </span>
          )}
        </DetailItem>

        <DetailItem label="Certificate status">
          <CertificateStatusBadge status={status} />
        </DetailItem>

        <DetailItem label="Uploaded">
          <span className="text-sm text-muted-foreground">
            {formatDateTime(certificate.createdAt)}
            {certificate.uploadedByName
              ? ` by ${certificate.uploadedByName}`
              : ""}
          </span>
        </DetailItem>
      </dl>

      {status === "EXPIRED" ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          This certificate has expired. The part should not be released against
          it until a current document is on file.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{certificate.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {formatFileSize(certificate.fileSize)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/*
            Both links point at the same authenticated route; only the
            disposition differs. There is no public URL for these files — the
            storage key never leaves the server, and this address is worthless
            without a session.
          */}
          <Button variant="outline" size="sm" asChild>
            <a href={certificate.fileUrl} target="_blank" rel="noreferrer">
              <Eye />
              View
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={`${certificate.fileUrl}?download=1`}>
              <Download />
              Download
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}

function DetailItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Confirmation for withdrawing a certificate.
 *
 * The copy says what actually happens, which is not deletion: the record and
 * its file are kept and the product simply reads as having none. Promising a
 * deletion this system does not perform would be worse than the mild surprise
 * of explaining the retention.
 */
function WithdrawCertificateDialog({
  open,
  onOpenChange,
  certificate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  certificate: CertificatePanelData;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleWithdraw() {
    setSubmitting(true);
    const result = await removeCertificateAction(certificate.id);
    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    onOpenChange(false);
    toast.success(result.message);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" aria-hidden />
            Withdraw certificate
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">
              {certificate.certificateNumber}
            </span>{" "}
            will no longer cover this part, and the product will show as having
            no certificate.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          The record is kept. This certificate and its file move into the
          product&apos;s certificate history, where they stay readable — that a
          document existed and was withdrawn is itself part of the audit trail.
        </p>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={submitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={handleWithdraw}
            disabled={submitting}
          >
            {submitting ? <Loader2 className="animate-spin" /> : null}
            {submitting ? "Withdrawing…" : "Withdraw certificate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { CertificatePanel };
