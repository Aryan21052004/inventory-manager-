"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Loader2,
  Pencil,
  Trash2,
  Truck,
} from "lucide-react";
import { toast } from "sonner";

import { setSupplierStatusAction } from "@/app/(app)/suppliers/actions";
import { ArchiveSupplierDialog } from "@/app/(app)/suppliers/archive-supplier-dialog";
import { DeleteSupplierDialog } from "@/app/(app)/suppliers/delete-supplier-dialog";
import { SupplierFormDialog } from "@/app/(app)/suppliers/supplier-form-dialog";
import { Button } from "@/components/ui/button";

/**
 * The controls on a supplier's detail page.
 *
 * The same actions the table row offers, laid out as buttons because there is
 * room and they are the reason someone opened the page. `canManage` decides
 * whether the archive, reactivate and delete controls appear at all; it hides
 * them, it does not protect them — every one re-checks for ADMIN on the server.
 *
 * Deleting is the one action that needs to do something afterwards: the page
 * the user is standing on describes a supplier who no longer exists, so it
 * navigates back to the list rather than leaving them looking at a ghost.
 */
function SupplierDetailActions({
  supplier,
  canManage,
}: {
  supplier: {
    id: string;
    name: string;
    contactPerson: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    accountNumber: string | null;
    typicalLeadTimeDays: number | null;
    status: "ACTIVE" | "INACTIVE";
    purchaseCount: number;
    productCount: number;
  };
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, startRestore] = useTransition();

  const archived = supplier.status === "INACTIVE";

  function handleRestore() {
    startRestore(async () => {
      const result = await setSupplierStatusAction(supplier.id, "ACTIVE");

      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      toast.success(result.message);
      router.refresh();
    });
  }

  return (
    <>
      {/* An archived supplier cannot be picked for a new purchase, so the
          button that would start one is not offered until they are back. */}
      {!archived ? (
        <Button variant="outline" asChild>
          <Link href="/purchases/new">
            <Truck />
            New purchase
          </Link>
        </Button>
      ) : null}

      <Button onClick={() => setEditing(true)}>
        <Pencil />
        Edit
      </Button>

      {canManage ? (
        <>
          {archived ? (
            <Button
              variant="outline"
              onClick={handleRestore}
              disabled={restoring}
            >
              {restoring ? (
                <Loader2 className="animate-spin" />
              ) : (
                <ArchiveRestore />
              )}
              {restoring ? "Reactivating…" : "Reactivate"}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Archive supplier"
              onClick={() => setArchiving(true)}
            >
              <Archive />
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete supplier"
            onClick={() => setDeleting(true)}
          >
            <Trash2 className="text-destructive" />
          </Button>
        </>
      ) : null}

      <SupplierFormDialog
        open={editing}
        onOpenChange={setEditing}
        supplier={supplier}
      />

      {canManage ? (
        <>
          <ArchiveSupplierDialog
            open={archiving}
            onOpenChange={setArchiving}
            supplier={supplier}
          />
          <DeleteSupplierDialog
            open={deleting}
            onOpenChange={setDeleting}
            supplier={supplier}
            onDeleted={() => router.push("/suppliers")}
          />
        </>
      ) : null}
    </>
  );
}

export { SupplierDetailActions };
