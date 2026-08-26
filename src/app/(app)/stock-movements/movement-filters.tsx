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
  hasActiveMovementFilters,
  MOVEMENT_TYPE_LABELS,
  MOVEMENT_TYPES,
  movementsHref,
  type MovementListParams,
} from "@/lib/stock-movement-query";
import type { StockTransactionType } from "@/generated/prisma/enums";

const ANY = "__any__";

function MovementFilters({
  params,
  products,
}: {
  params: MovementListParams;
  products: { id: string; name: string; sku: string }[];
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
        router.push(
          movementsHref({ ...paramsRef.current, search, page: 1 }),
          { scroll: false },
        ),
      );
    }, 300);

    return () => clearTimeout(timer);
  }, [search, router]);

  const navigate = (next: MovementListParams) => {
    startTransition(() => router.push(movementsHref(next), { scroll: false }));
  };

  const setFilter = (patch: Partial<MovementListParams>) =>
    navigate({ ...params, ...patch, page: 1 });

  const filtered = hasActiveMovementFilters(params);

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
            placeholder="Search by product name or SKU…"
            aria-label="Search stock movements by product name or SKU"
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
            value={params.type ?? ANY}
            onValueChange={(next) =>
              setFilter({
                type:
                  next === ANY ? null : (next as StockTransactionType),
              })
            }
          >
            <SelectTrigger aria-label="Movement type" className="lg:w-44">
              <SelectValue placeholder="Any type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any type</SelectItem>
              {MOVEMENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {MOVEMENT_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={params.productId ?? ANY}
            onValueChange={(next) =>
              setFilter({ productId: next === ANY ? null : next })
            }
          >
            <SelectTrigger aria-label="Product" className="lg:w-52">
              <SelectValue placeholder="All products" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All products</SelectItem>
              {products.map((product) => (
                <SelectItem key={product.id} value={product.id}>
                  {product.name}
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
                productId: null,
                type: null,
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

export { MovementFilters };
