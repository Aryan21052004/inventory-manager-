import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Page controls for a server-rendered list.
 *
 * Links, not buttons. The page number lives in the URL, so a page is something
 * you can bookmark and the browser's back button walks back through — and the
 * controls keep working before any JavaScript has loaded. Disabled ends are
 * rendered as plain spans rather than links to nowhere.
 */
function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  hrefFor,
  className,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  /** Builds the href for a page number, keeping the rest of the state intact. */
  hrefFor: (page: number) => string;
  className?: string;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <p className="text-xs text-muted-foreground">
        {total === 0 ? (
          "No products to show"
        ) : (
          <>
            Showing <span className="tabular font-medium text-foreground">{first}</span>
            –<span className="tabular font-medium text-foreground">{last}</span> of{" "}
            <span className="tabular font-medium text-foreground">{total}</span>
          </>
        )}
      </p>

      <div className="flex items-center gap-2">
        <PageLink
          href={hrefFor(page - 1)}
          disabled={page <= 1}
          label="Previous page"
        >
          <ChevronLeft />
          <span className="hidden sm:inline">Previous</span>
        </PageLink>

        <span className="tabular px-2 text-xs text-muted-foreground">
          Page {page} of {pageCount}
        </span>

        <PageLink
          href={hrefFor(page + 1)}
          disabled={page >= pageCount}
          label="Next page"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight />
        </PageLink>
      </div>
    </div>
  );
}

function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled aria-label={label}>
        {children}
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={href} aria-label={label} prefetch={false}>
        {children}
      </Link>
    </Button>
  );
}

export { Pagination };
