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
  hasActivePurchaseFilters,
  purchasesHref,
  type PurchaseListParams,
} from "@/lib/purchase-query";
import {
  PURCHASE_STATUSES,
  purchaseStatusLabel,
} from "@/lib/purchase-status";

/**
 * Search and filters for the purchases list.
 *
 * Every control writes to the URL, the filtering happens in Postgres, and the
 * page stays a server component. The search box is the only piece holding local
 * state, because typing has to feel immediate and the navigation behind it is
 * debounced.
 */

const ANY = "__any__";

function PurchaseFilters({
  params,
  suppliers,
}: {
  params: PurchaseListParams;
  suppliers: { id: string; name: string }[];
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
        router.push(purchasesHref({ ...paramsRef.current, search, page: 1 }), {
          scroll: false,
        }),
      );
    }, 300);

    return () => clearTimeout(timer);
  }, [search, router]);

  const navigate = (next: PurchaseListParams) => {
    startTransition(() => router.push(purchasesHref(next), { scroll: false }));
  };

  // Any filter change returns to page one.
  const setFilter = (patch: Partial<PurchaseListParams>) =>
    navigate({ ...params, ...patch, page: 1 });

  const filtered = hasActivePurchaseFilters(params);

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
            placeholder="Search by purchase number or supplier…"
            aria-label="Search purchases by number or supplier"
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
                status:
                  next === ANY ? null : (next as PurchaseListParams["status"]),
              })
            }
          >
            <SelectTrigger aria-label="Status" className="lg:w-44">
              <SelectValue placeholder="Any status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any status</SelectItem>
              {PURCHASE_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {purchaseStatusLabel(status)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={params.supplierId ?? ANY}
            onValueChange={(next) =>
              setFilter({ supplierId: next === ANY ? null : next })
            }
          >
            <SelectTrigger aria-label="Supplier" className="lg:w-52">
              <SelectValue placeholder="All suppliers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All suppliers</SelectItem>
              {suppliers.map((supplier) => (
                <SelectItem key={supplier.id} value={supplier.id}>
                  {supplier.name}
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
            onClick={() =>
              navigate({
                ...params,
                search: "",
                supplierId: null,
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

export { PurchaseFilters };
