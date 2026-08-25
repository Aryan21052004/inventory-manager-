"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import {
  ProductFormDialog,
  type SupplierOption,
} from "@/app/(app)/products/product-form-dialog";
import { Button } from "@/components/ui/button";

/**
 * The "New product" button and the dialog it opens.
 *
 * A separate component only so the page it sits on can stay a server component
 * — the open/closed state is the one thing on that page that needs the browser.
 */
function NewProductButton({
  categories,
  suppliers,
}: {
  categories: string[];
  suppliers: SupplierOption[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New product
      </Button>

      <ProductFormDialog
        open={open}
        onOpenChange={setOpen}
        categories={categories}
        suppliers={suppliers}
      />
    </>
  );
}

export { NewProductButton };
