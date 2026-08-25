import type { Metadata } from "next";
import { Plus, Truck } from "lucide-react";

import { ModulePlaceholder } from "@/components/module-placeholder";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Suppliers" };

export default function SuppliersPage() {
  return (
    <ModulePlaceholder
      title="Suppliers"
      description="Who you buy from, what they supply, and how restocking is going."
      icon={Truck}
      actions={
        <Button disabled>
          <Plus />
          New supplier
        </Button>
      }
      planned={[
        "Supplier directory with contact details",
        "Products linked to their supplier",
        "Purchase history and outstanding orders",
        "Lead times and reorder suggestions",
      ]}
    />
  );
}
