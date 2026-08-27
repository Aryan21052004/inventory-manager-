"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Eye,
  MoreHorizontal,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The per-row actions menu.
 *
 * The dialogs are siblings of the menu rather than children of it. A Radix
 * dropdown unmounts its content when it closes, so a dialog opened from inside
 * one would be torn down in the same moment it appeared; the menu item sets a
 * piece of state and the dialog, which lives outside, reacts to it.
 *
 * Two tiers, matching the module's rules. Viewing, editing and raising a
 * purchase are ordinary work that any signed-in user does. Archiving,
 * reactivating and deleting are ADMIN, and `canManage` hides them — it hides,
 * it does not protect. Every action behind these items re-checks the role on
 * the server against our own database, because a hidden menu item stops nobody
 * who can call the action directly.
 */

export interface SupplierRow {
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
}

function SupplierRowActions({
  supplier,
  canManage,
}: {
  supplier: SupplierRow;
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, startRestore] = useTransition();

  const archived = supplier.status === "INACTIVE";

  /*
   * Bringing a supplier back needs no confirmation — it puts them back in the
   * two pickers and nothing else — so it runs straight from the menu. Archiving
   * is the direction that changes what other people see, and it asks first.
   */
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${supplier.name}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/suppliers/${supplier.id}`}>
              <Eye />
              View details
            </Link>
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil />
            Edit supplier
          </DropdownMenuItem>

          {/* An archived supplier cannot be picked for a new purchase, so the
              shortcut that would take you there is not offered. */}
          {!archived ? (
            <DropdownMenuItem asChild>
              <Link href="/purchases/new">
                <Truck />
                New purchase
              </Link>
            </DropdownMenuItem>
          ) : null}

          {canManage ? (
            <>
              <DropdownMenuSeparator />

              {archived ? (
                <DropdownMenuItem onSelect={handleRestore} disabled={restoring}>
                  <ArchiveRestore />
                  {restoring ? "Reactivating…" : "Reactivate"}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => setArchiving(true)}>
                  <Archive />
                  Archive
                </DropdownMenuItem>
              )}

              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleting(true)}
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

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
          />
        </>
      ) : null}
    </>
  );
}

export { SupplierRowActions };
