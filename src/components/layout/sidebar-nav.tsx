"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { navSections } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * The navigation list, shared by the desktop sidebar and the mobile drawer so
 * the two can never drift apart.
 *
 * Active state is matched on prefix, which means a detail route such as
 * `/products/abc123` keeps Products highlighted.
 */
function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-6" aria-label="Main">
      {navSections.map((section, index) => (
        <div key={section.label ?? `section-${index}`} className="flex flex-col gap-1">
          {section.label ? (
            <h2 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              {section.label}
            </h2>
          ) : null}

          {section.items.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(`${item.href}/`);

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <item.icon
                  className={cn(
                    "size-4 shrink-0 transition-colors",
                    isActive
                      ? "text-primary"
                      : "text-muted-foreground group-hover:text-foreground",
                  )}
                  aria-hidden
                />
                <span className="truncate">{item.title}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export { SidebarNav };
