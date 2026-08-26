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
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { setCustomerStatusAction } from "@/app/(app)/customers/actions";
import { ArchiveCustomerDialog } from "@/app/(app)/customers/archive-customer-dialog";
import { CustomerFormDialog } from "@/app/(app)/customers/customer-form-dialog";
import { DeleteCustomerDialog } from "@/app/(app)/customers/delete-customer-dialog";
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
 * Two tiers, matching the module's rules. Viewing, editing and raising an order
 * are ordinary work that any signed-in user does. Archiving and deleting are
 * ADMIN, and `canManage` hides them — it hides, it does not protect. Every
 * action behind these items re-checks the role on the server against our own
 * database, because a hidden menu item stops nobody who can call the action
 * directly.
 */

export interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: "ACTIVE" | "INACTIVE";
  orderCount: number;
}

function CustomerRowActions({
  customer,
  canManage,
}: {
  customer: CustomerRow;
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, startRestore] = useTransition();

  const archived = customer.status === "INACTIVE";

  /*
   * Bringing a customer back needs no confirmation — it puts them back in the
   * picker and nothing else — so it runs straight from the menu. Archiving is
   * the direction that changes what other people see, and it asks first.
   */
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${customer.name}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/customers/${customer.id}`}>
              <Eye />
              View details
            </Link>
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil />
            Edit customer
          </DropdownMenuItem>

          {/* An archived customer cannot be picked for a new order, so the
              shortcut that would take you there is not offered. */}
          {!archived ? (
            <DropdownMenuItem asChild>
              <Link href={`/orders/new?customer=${customer.id}`}>
                <ShoppingCart />
                New order
              </Link>
            </DropdownMenuItem>
          ) : null}

          {canManage ? (
            <>
              <DropdownMenuSeparator />

              {archived ? (
                <DropdownMenuItem
                  onSelect={handleRestore}
                  disabled={restoring}
                >
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
          />
        </>
      ) : null}
    </>
  );
}

export { CustomerRowActions };
