"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { toast } from "sonner";

import { MobileNav } from "@/components/layout/mobile-nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { findNavItem } from "@/lib/nav";

/**
 * Sticky top bar: drawer trigger, current section, global search, and account
 * controls.
 *
 * The title is derived from the route rather than passed in by each page, so a
 * page cannot forget to set it or set one that disagrees with the sidebar.
 */
function Header({
  appName,
  authEnabled,
}: {
  appName: string;
  authEnabled: boolean;
}) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const current = findNavItem(pathname);

  function handleSearch(event: React.FormEvent) {
    event.preventDefault();
    const term = query.trim();
    if (term === "") return;

    // Global search spans products, orders and customers, none of which are
    // queryable yet. Saying so beats a box that silently swallows input.
    toast.info("Global search is not connected yet", {
      description: `"${term}" will search products, orders and customers once those modules land.`,
    });
  }

  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-6">
      <MobileNav appName={appName} />

      <Separator orientation="vertical" className="mr-1 h-6 lg:hidden" />

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold">
          {current?.title ?? appName}
        </h1>
        {current?.description ? (
          <p className="hidden truncate text-xs text-muted-foreground sm:block">
            {current.description}
          </p>
        ) : null}
      </div>

      <form onSubmit={handleSearch} className="hidden md:block" role="search">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search inventory…"
            aria-label="Search inventory"
            className="w-56 bg-muted/50 pl-8 lg:w-72"
          />
        </div>
      </form>

      <div className="flex items-center gap-1">
        <ThemeToggle />
        <UserMenu authEnabled={authEnabled} />
      </div>
    </header>
  );
}

export { Header };
