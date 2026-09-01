"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  hasActiveFilters,
  productsHref,
  PRODUCT_STATUSES,
  type ProductListParams,
  type ProductStatusFilter,
} from "@/lib/product-query";

/**
 * The search and filter bar.
 *
 * Every control writes to the URL and nothing else. The filtering itself
 * happens in Postgres, on the server, against the query string this produces —
 * which is what keeps a catalogue of any size to one page of rows over the wire
 * and makes a filtered view something you can send someone.
 *
 * The consequence is that this component holds almost no state. The one
 * exception is the search box: typing has to feel immediate, so the input is
 * controlled locally and the navigation is debounced behind it.
 */

/**
 * Radix reserves the empty string for "nothing selected", so the "any" option
 * in each dropdown needs a value of its own. It is mapped back to null on the
 * way into the URL, where absent means unfiltered.
 */
const ANY = "__any__";

const STATUS_LABELS: Record<ProductStatusFilter, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  DISCONTINUED: "Discontinued",
};

function ProductFilters({
  params,
  categories,
}: {
  params: ProductListParams;
  categories: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [search, setSearch] = useState(params.search);

  /**
   * The last search term this component sent to the URL. It is what tells an
   * echo of our own navigation apart from a change that came from somewhere
   * else — the Clear button, the back button, a pasted link — so the input
   * adopts the second without the first overwriting what is being typed.
   */
  const lastPushed = useRef(params.search);

  /*
   * The current filters, kept where the debounce timer can read them.
   *
   * The timer fires 300ms after the last keystroke and needs whatever the other
   * filters are *then*, not what they were when it was scheduled. A dependency
   * on `params` would restart the timer on every render — the object is new
   * each time — so the value is mirrored into a ref instead, updated in an
   * effect rather than during render.
   */
  const paramsRef = useRef(params);

  useEffect(() => {
    paramsRef.current = params;
  });

  const navigate = (next: ProductListParams) => {
    startTransition(() => router.push(productsHref(next), { scroll: false }));
  };

  useEffect(() => {
    if (params.search !== lastPushed.current) {
      lastPushed.current = params.search;
      setSearch(params.search);
    }
  }, [params.search]);

  useEffect(() => {
    if (search === lastPushed.current) return;

    // Long enough that a typed word is one request rather than five, short
    // enough that stopping typing feels like it acted.
    const timer = setTimeout(() => {
      lastPushed.current = search;
      startTransition(() =>
        router.push(
          productsHref({ ...paramsRef.current, search, page: 1 }),
          { scroll: false },
        ),
      );
    }, 300);

    return () => clearTimeout(timer);
  }, [search, router]);

  /** Any filter change returns to page one — page four of the old result set
   *  has nothing to do with page four of the new one. */
  const setFilter = (patch: Partial<ProductListParams>) => {
    navigate({ ...params, ...patch, page: 1 });
  };

  const filtered = hasActiveFilters(params);

  return (
    <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center">
      <div className="relative flex-1 lg:max-w-sm">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or SKU…"
          aria-label="Search products by name or SKU"
          className="pl-9 pr-9"
        />
        {pending ? (
          <Loader2
            className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:flex lg:flex-1 lg:justify-end">
        <FilterSelect
          label="Category"
          value={params.category}
          onChange={(value) => setFilter({ category: value })}
          placeholder="All categories"
          options={categories.map((category) => ({
            value: category,
            label: category,
          }))}
        />

        <FilterSelect
          label="Status"
          value={params.status}
          onChange={(value) =>
            setFilter({ status: value as ProductStatusFilter | null })
          }
          placeholder="Any status"
          options={PRODUCT_STATUSES.map((status) => ({
            value: status,
            label: STATUS_LABELS[status],
          }))}
        />

        {filtered ? (
          <Button
            variant="ghost"
            onClick={() =>
              navigate({
                ...params,
                search: "",
                category: null,
                status: null,
                supplierId: null,
                page: 1,
              })
            }
            className="col-span-2 sm:col-span-1"
          >
            <X />
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  placeholder,
  options,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder: string;
  options: { value: string; label: string }[];
}) {
  return (
    <Select
      value={value ?? ANY}
      onValueChange={(next) => onChange(next === ANY ? null : next)}
    >
      <SelectTrigger aria-label={label} className="lg:w-44">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{placeholder}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export { ProductFilters };
