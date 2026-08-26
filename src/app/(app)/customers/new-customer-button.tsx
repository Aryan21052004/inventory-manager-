"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { CustomerFormDialog } from "@/app/(app)/customers/customer-form-dialog";
import { Button } from "@/components/ui/button";

/**
 * The "New customer" button and the dialog it opens.
 *
 * A separate component only so the page it sits on can stay a server component
 * — the open/closed state is the one thing on that page that needs the browser.
 */
function NewCustomerButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New customer
      </Button>

      <CustomerFormDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export { NewCustomerButton };
