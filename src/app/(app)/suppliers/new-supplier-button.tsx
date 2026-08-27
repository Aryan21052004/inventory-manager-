"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { SupplierFormDialog } from "@/app/(app)/suppliers/supplier-form-dialog";
import { Button } from "@/components/ui/button";

/**
 * The "New supplier" button and the dialog it opens.
 *
 * A separate component only so the page it sits on can stay a server component
 * — the open/closed state is the one thing on that page that needs the browser.
 */
function NewSupplierButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New supplier
      </Button>

      <SupplierFormDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export { NewSupplierButton };
