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
  type ReportDefaults,
} from "@/lib/report-query";
import {
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABELS,
} from "@/lib/stock-movement-query";
import type {
  LotStatus,
  ProductStatus,
  StockTransactionType,
} from "@/generated/prisma/enums";
import {
  certificateStatusLabel,
  type CertificateStatus,
} from "@/lib/certificate-status";
import {
  LOT_STATUS_LABELS,
  QUARANTINED_LOT_STATUS,
  REJECTED_LOT_STATUS,
  SALEABLE_LOT_STATUS,
} from "@/lib/lot-status";
import { PRODUCT_STATUSES } from "@/lib/product-query";

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

/*
 * The compliance register's option lists.
 *
 * Statuses come from the modules that own them — `lot-status.ts` for batches
 * and `product-query.ts` for products — rather than being spelled again here.
 * The certificate states are the four `certificateStatus()` returns, labelled
 * by the same function the badge uses.
 */
const CERTIFICATE_STATUS_OPTIONS: readonly CertificateStatus[] = [
  "MISSING",
  "EXPIRED",
  "EXPIRING_SOON",
  "VALID",
];

const LOT_STATUS_OPTIONS: readonly LotStatus[] = [
  SALEABLE_LOT_STATUS,
  QUARANTINED_LOT_STATUS,
  REJECTED_LOT_STATUS,
];

const PRODUCT_STATUS_OPTIONS = PRODUCT_STATUSES;

const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  DISCONTINUED: "Discontinued",
};

function ReportFilters({
  report,
  params,
  defaults,
  groupings,
  categories,
  movementTypes = false,
  certificates = false,
  certificateTypes = [],
}: {
  report: ReportKey;
  params: ReportParams;
  defaults: ReportDefaults;
  /** Empty for a report that does not group. */
  groupings: readonly string[];
  categories: string[];
  /** Only the stock movement summary filters by ledger type. */
  movementTypes?: boolean;
  /** Only the compliance register filters by paperwork and batch state. */
  certificates?: boolean;
  /**
   * The certificate types actually on file. An open string set, read from the
   * data rather than declared, so the options are whatever has been filed.
   */
  certificateTypes?: string[];
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
    Boolean(params.search || params.category || params.movementType) ||
    Boolean(
      params.certificateStatus ||
        params.certificateType ||
        params.lotStatus ||
        params.includeEmptied,
    ) ||
    params.productStatus !== (defaults.productStatus ?? null) ||
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

          {movementTypes ? (
            <Select
              value={params.movementType ?? ANY}
              onValueChange={(next) =>
                navigate({
                  ...params,
                  movementType:
                    next === ANY ? null : (next as StockTransactionType),
                  page: 1,
                })
              }
            >
              <SelectTrigger aria-label="Movement type" className="w-44">
                <SelectValue placeholder="All movements" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All movements</SelectItem>
                {MOVEMENT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {MOVEMENT_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {certificates ? (
            <>
              <Select
                value={params.certificateStatus ?? ANY}
                onValueChange={(next) =>
                  navigate({
                    ...params,
                    certificateStatus:
                      next === ANY ? null : (next as CertificateStatus),
                    page: 1,
                  })
                }
              >
                <SelectTrigger aria-label="Compliance" className="w-44">
                  <SelectValue placeholder="All compliance" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All compliance</SelectItem>
                  {CERTIFICATE_STATUS_OPTIONS.map((status) => (
                    <SelectItem key={status} value={status}>
                      {certificateStatusLabel(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/*
                Only offered when something is filed. An empty select would be
                a control that cannot do anything, which reads as broken rather
                than as "no certificates yet".
              */}
              {certificateTypes.length > 0 ? (
                <Select
                  value={params.certificateType ?? ANY}
                  onValueChange={(next) =>
                    navigate({
                      ...params,
                      certificateType: next === ANY ? null : next,
                      page: 1,
                    })
                  }
                >
                  <SelectTrigger aria-label="Certificate type" className="w-48">
                    <SelectValue placeholder="All certificate types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>All certificate types</SelectItem>
                    {certificateTypes.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}

              <Select
                value={params.lotStatus ?? ANY}
                onValueChange={(next) =>
                  navigate({
                    ...params,
                    lotStatus: next === ANY ? null : (next as LotStatus),
                    page: 1,
                  })
                }
              >
                <SelectTrigger aria-label="Batch status" className="w-40">
                  <SelectValue placeholder="All batches" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All batches</SelectItem>
                  {LOT_STATUS_OPTIONS.map((status) => (
                    <SelectItem key={status} value={status}>
                      {LOT_STATUS_LABELS[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/*
                Retired stock is in the register; this only decides which of it
                is on screen. "All" is a real option, not a hidden one.
              */}
              <Select
                value={params.productStatus ?? ANY}
                onValueChange={(next) =>
                  navigate({
                    ...params,
                    productStatus:
                      next === ANY ? null : (next as ProductStatus),
                    page: 1,
                  })
                }
              >
                <SelectTrigger aria-label="Product status" className="w-44">
                  <SelectValue placeholder="All products" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>All product statuses</SelectItem>
                  {PRODUCT_STATUS_OPTIONS.map((status) => (
                    <SelectItem key={status} value={status}>
                      {PRODUCT_STATUS_LABELS[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                variant={params.includeEmptied ? "secondary" : "outline"}
                onClick={() =>
                  navigate({
                    ...params,
                    includeEmptied: !params.includeEmptied,
                    page: 1,
                  })
                }
                aria-pressed={params.includeEmptied}
              >
                {params.includeEmptied
                  ? "Emptied batches shown"
                  : "Include emptied batches"}
              </Button>
            </>
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
                  movementType: null,
                  certificateStatus: null,
                  certificateType: null,
                  lotStatus: null,
                  productStatus: defaults.productStatus ?? null,
                  includeEmptied: false,
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
