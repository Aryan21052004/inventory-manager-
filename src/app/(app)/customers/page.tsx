import type { Metadata } from "next";
import { Plus, Users } from "lucide-react";

import { ModulePlaceholder } from "@/components/module-placeholder";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Customers" };

export default function CustomersPage() {
  return (
    <ModulePlaceholder
      title="Customers"
      description="The people and businesses you sell to, and what they have ordered."
      icon={Users}
      actions={
        <Button disabled>
          <Plus />
          New customer
        </Button>
      }
      planned={[
        "Customer directory with contact details",
        "Order history and lifetime value per customer",
        "Search and archive inactive customers",
        "Quick order creation from a customer record",
      ]}
    />
  );
}
