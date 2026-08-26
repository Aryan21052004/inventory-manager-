"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  hasActiveOrderFilters,
  ordersHref,
  type OrderListParams,
} from "@/lib/order-query";
import { ORDER_STATUSES, orderStatusLabel } from "@/lib/order-status";

/**
 * Search and filters for the orders list.
 *
 * Same arrangement as the products filter bar: every control writes to the URL,
 * the filtering happens in Postgres, and the page stays a server component. The
 * search box is the only piece holding local state, because typing has to feel
 * immediate and the navigation behind it is debounced.
 */

const ANY = "__any__";

function OrderFilters({
  params,
  customers,
}: {
  params: OrderListParams;
  customers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(params.search);

  const lastPushed = useRef(params.search);
  const paramsRef = useRef(params);

  useEffect(() => {
    paramsRef.current = params;
  });

  useEffect(() => {
    if (params.search !== lastPushed.current) {
      lastPushed.current = params.search;
      setSearch(params.search);
    }
  }, [params.search]);

  useEffect(() => {
    if (search === lastPushed.current) return;

    const timer = setTimeout(() => {
      lastPushed.current = search;
      startTransition(() =>
        router.push(ordersHref({ ...paramsRef.current, search, page: 1 }), {
          scroll: false,
        }),
      );
    }, 300);

    return () => clearTimeout(timer);
  }, [search, router]);

  const navigate = (next: OrderListParams) => {
    startTransition(() => router.push(ordersHref(next), { scroll: false }));
  };

  // Any filter change returns to page one — page four of the old result set has
  // nothing to do with page four of the new one.
  const setFilter = (patch: Partial<OrderListParams>) =>
    navigate({ ...params, ...patch, page: 1 });

  const filtered = hasActiveOrderFilters(params);

  return (
    <div className="flex flex-col gap-3 border-b border-border p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1 lg:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by order number or customer…"
            aria-label="Search orders by number or customer"
            className="pl-9 pr-9"
          />
          {pending ? (
            <Loader2
              className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
              aria-hidden
            />
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3 lg:flex lg:flex-1 lg:justify-end">
          <Select
            value={params.status ?? ANY}
            onValueChange={(next) =>
              setFilter({
                status: next === ANY ? null : (next as OrderListParams["status"]),
              })
            }
          >
            <SelectTrigger aria-label="Status" className="lg:w-44">
              <SelectValue placeholder="Any status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any status</SelectItem>
              {ORDER_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {orderStatusLabel(status)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={params.customerId ?? ANY}
            onValueChange={(next) =>
              setFilter({ customerId: next === ANY ? null : next })
            }
          >
            <SelectTrigger aria-label="Customer" className="lg:w-52">
              <SelectValue placeholder="All customers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All customers</SelectItem>
              {customers.map((customer) => (
                <SelectItem key={customer.id} value={customer.id}>
                  {customer.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="From" htmlFor="from" className="sm:w-44">
          <Input
            id="from"
            type="date"
            value={params.from ?? ""}
            onChange={(event) => setFilter({ from: event.target.value || null })}
          />
        </Field>

        <Field label="To" htmlFor="to" className="sm:w-44">
          <Input
            id="to"
            type="date"
            value={params.to ?? ""}
            onChange={(event) => setFilter({ to: event.target.value || null })}
          />
        </Field>

        {filtered ? (
          <Button
            variant="ghost"
            className="sm:mb-0"
            onClick={() =>
              navigate({
                ...params,
                search: "",
                customerId: null,
                status: null,
                from: null,
                to: null,
                page: 1,
              })
            }
          >
            <X />
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export { OrderFilters };
