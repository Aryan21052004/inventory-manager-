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
  suppliersHref,
  SUPPLIER_STATUSES,
  SUPPLIER_STATUS_LABELS,
  hasActiveSupplierFilters,
  type SupplierListParams,
} from "@/lib/supplier-query";

/**
 * The search and filter bar.
 *
 * Every control writes to the URL and nothing else. The filtering happens in
 * Postgres, on the server, against the query string this produces — which keeps
 * a directory of any size to one page of rows over the wire and makes a
 * filtered view something you can send someone.
 *
 * The status filter offers archived suppliers deliberately. A picker excludes
 * them — no new business — but a filter is how somebody *finds* them, and
 * hiding archived suppliers here would make their history unreachable from the
 * only control that could reach it.
 *
 * The consequence is that this component holds almost no state. The one
 * exception is the search box: typing has to feel immediate, so the input is
 * controlled locally and the navigation is debounced behind it.
 */

/**
 * Radix reserves the empty string for "nothing selected", so the "any" option
 * needs a value of its own. It is mapped back to null on the way into the URL,
 * where absent means unfiltered.
 */
const ANY = "__any__";

function SupplierFilters({ params }: { params: SupplierListParams }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [search, setSearch] = useState(params.search);

  /**
   * The last search term this component sent to the URL. It tells an echo of
   * our own navigation apart from a change that came from somewhere else — the
   * Clear button, the back button, a pasted link — so the input adopts the
   * second without the first overwriting what is being typed.
   */
  const lastPushed = useRef(params.search);

  /*
   * The current filters, kept where the debounce timer can read them. The timer
   * fires after the last keystroke and needs whatever the other filters are
   * *then*, not what they were when it was scheduled. A dependency on `params`
   * would restart the timer on every render — the object is new each time — so
   * the value is mirrored into a ref, updated in an effect rather than during
   * render.
   */
  const paramsRef = useRef(params);

  useEffect(() => {
    paramsRef.current = params;
  });

  const navigate = (next: SupplierListParams) => {
    startTransition(() => router.push(suppliersHref(next), { scroll: false }));
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
        router.push(suppliersHref({ ...paramsRef.current, search, page: 1 }), {
          scroll: false,
        }),
      );
    }, 300);

    return () => clearTimeout(timer);
  }, [search, router]);

  const filtered = hasActiveSupplierFilters(params);

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
          placeholder="Search by name, contact, email or account…"
          aria-label="Search suppliers by name, contact person, email, phone or account number"
          className="pl-9 pr-9"
        />
        {pending ? (
          <Loader2
            className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : null}
      </div>

      <div className="flex gap-3 lg:flex-1 lg:justify-end">
        <Select
          value={params.status ?? ANY}
          onValueChange={(next) =>
            navigate({
              ...params,
              status:
                next === ANY
                  ? null
                  : (next as SupplierListParams["status"]),
              page: 1,
            })
          }
        >
          <SelectTrigger aria-label="Status" className="flex-1 lg:w-44 lg:flex-none">
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            {SUPPLIER_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {SUPPLIER_STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {filtered ? (
          <Button
            variant="ghost"
            onClick={() =>
              navigate({ ...params, search: "", status: null, page: 1 })
            }
          >
            <X />
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export { SupplierFilters };
