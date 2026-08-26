"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Loader2,
  Pencil,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { setCustomerStatusAction } from "@/app/(app)/customers/actions";
import { ArchiveCustomerDialog } from "@/app/(app)/customers/archive-customer-dialog";
import { CustomerFormDialog } from "@/app/(app)/customers/customer-form-dialog";
import { DeleteCustomerDialog } from "@/app/(app)/customers/delete-customer-dialog";
import { Button } from "@/components/ui/button";

/**
 * The controls on a customer's detail page.
 *
 * The same actions the table row offers, laid out as buttons because there is
 * room and they are the reason someone opened the page. `canManage` decides
 * whether the archive and delete controls appear at all; it hides them, it does
 * not protect them — both actions re-check for ADMIN on the server.
 *
 * Deleting is the one action that needs to do something afterwards: the page
 * the user is standing on describes a customer who no longer exists, so it
 * navigates back to the list rather than leaving them looking at a ghost.
 */
function CustomerDetailActions({
  customer,
  canManage,
}: {
  customer: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    status: "ACTIVE" | "INACTIVE";
    orderCount: number;
  };
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, startRestore] = useTransition();

  const archived = customer.status === "INACTIVE";

  function handleRestore() {
    startRestore(async () => {
      const result = await setCustomerStatusAction(customer.id, "ACTIVE");

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
      {/* An archived customer cannot be picked for a new order, so the button
          that would start one is not offered until they are back. */}
      {!archived ? (
        <Button variant="outline" asChild>
          <Link href={`/orders/new?customer=${customer.id}`}>
            <ShoppingCart />
            New order
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
              aria-label="Archive customer"
              onClick={() => setArchiving(true)}
            >
              <Archive />
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete customer"
            onClick={() => setDeleting(true)}
          >
            <Trash2 className="text-destructive" />
          </Button>
        </>
      ) : null}

      <CustomerFormDialog
        open={editing}
        onOpenChange={setEditing}
        customer={customer}
      />

      {canManage ? (
        <>
          <ArchiveCustomerDialog
            open={archiving}
            onOpenChange={setArchiving}
            customer={customer}
          />
          <DeleteCustomerDialog
            open={deleting}
            onOpenChange={setDeleting}
            customer={customer}
            onDeleted={() => router.push("/customers")}
          />
        </>
      ) : null}
    </>
  );
}

export { CustomerDetailActions };
