"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { MobileNav } from "@/components/layout/mobile-nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { findNavItem } from "@/lib/nav";

/**
 * Sticky top bar: drawer trigger, current section, and account controls.
 *
 * It shares `bg-sidebar` with the nav rail so the chrome reads as one frame
 * around the content, and it is deliberately opaque: a translucent, blurred bar
 * sitting over scrolling table rows reads as noise rather than as depth.
 *
 * The title is derived from the route rather than passed in by each page, so a
 * page cannot forget to set it or set one that disagrees with the sidebar.
 *
 * `userMenu` arrives as a prop rather than being imported. The menu needs the
 * signed-in user's details, which are resolved on the server in `AppShell`;
 * importing it here would mean threading those details through this component,
 * which has no other use for them. The shell renders the finished element and
 * passes it through this slot instead.
 */
function Header({
  appName,
  userMenu,
}: {
  appName: string;
  userMenu: ReactNode;
}) {
  const pathname = usePathname();
  const current = findNavItem(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-4 sm:px-6">
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

      <div className="flex items-center gap-1">
        <ThemeToggle />
        {userMenu}
      </div>
    </header>
  );
}

export { Header };
