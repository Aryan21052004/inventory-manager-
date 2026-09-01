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
  GROUPING_LABELS,
  RANGE_PRESETS,
  RANGE_PRESET_LABELS,
  reportHref,
  type RangePreset,
  type ReportKey,
  type ReportParams,
} from "@/lib/report-query";

/**
 * The reports' filter bar.
 *
 * Every control writes to the URL and nothing else, which is what lets the CSV
 * endpoint be handed the same query string the page was rendered from. The
 * aggregation happens in Postgres; the browser never sees a transaction.
 *
 * As on the other lists, the one piece of local state is the search box —
 * typing has to feel immediate, so the input is controlled here and the
 * navigation is debounced behind it.
 */

const ANY = "__any__";

function ReportFilters({
  report,
  params,
  defaults,
  groupings,
  categories,
}: {
  report: ReportKey;
  params: ReportParams;
  defaults: { grouping: string; sort: string };
  /** Empty for a report that does not group. */
  groupings: readonly string[];
  categories: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(params.search);

  const lastPushed = useRef(params.search);
  const paramsRef = useRef(params);

  useEffect(() => {
    paramsRef.current = params;
  });

  const navigate = (next: ReportParams) => {
    startTransition(() =>
      router.push(reportHref(report, next, defaults), { scroll: false }),
    );
  };

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
          reportHref(
            report,
            { ...paramsRef.current, search, page: 1 },
            defaults,
          ),
          { scroll: false },
        ),
      );
    }, 300);

    return () => clearTimeout(timer);
  }, [search, router, report, defaults]);

  const filtered =
    Boolean(params.search || params.category) ||
    params.preset !== "12m" ||
    params.grouping !== defaults.grouping;

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
            placeholder="Search…"
            aria-label="Search this report"
            className="pl-9 pr-9"
          />
          {pending ? (
            <Loader2
              className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
              aria-hidden
            />
          ) : null}
        </div>

        <div className="flex flex-wrap gap-3 lg:flex-1 lg:justify-end">
          <Select
            value={params.preset}
            onValueChange={(next) =>
              navigate({ ...params, preset: next as RangePreset, page: 1 })
            }
          >
            <SelectTrigger aria-label="Period" className="w-44">
              <SelectValue placeholder="Period" />
            </SelectTrigger>
            <SelectContent>
              {RANGE_PRESETS.filter((preset) => preset !== "custom").map(
                (preset) => (
                  <SelectItem key={preset} value={preset}>
                    {RANGE_PRESET_LABELS[preset]}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>

          {groupings.length > 0 ? (
            <Select
              value={params.grouping}
              onValueChange={(next) =>
                navigate({ ...params, grouping: next, page: 1 })
              }
            >
              <SelectTrigger aria-label="Group by" className="w-40">
                <SelectValue placeholder="Group by" />
              </SelectTrigger>
              <SelectContent>
                {groupings.map((grouping) => (
                  <SelectItem key={grouping} value={grouping}>
                    {GROUPING_LABELS[grouping] ?? grouping}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {categories.length > 0 ? (
            <Select
              value={params.category ?? ANY}
              onValueChange={(next) =>
                navigate({
                  ...params,
                  category: next === ANY ? null : next,
                  page: 1,
                })
              }
            >
              <SelectTrigger aria-label="Category" className="w-44">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All categories</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category} value={category}>
                    {category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {filtered ? (
            <Button
              variant="ghost"
              onClick={() =>
                navigate({
                  ...params,
                  search: "",
                  category: null,
                  preset: "12m",
                  grouping: defaults.grouping,
                  page: 1,
                })
              }
            >
              <X />
              Reset
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export { ReportFilters };
