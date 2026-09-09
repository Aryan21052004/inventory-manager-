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
    <nav className="flex flex-col gap-5" aria-label="Main">
      {navSections.map((section, index) => (
        <div key={section.label ?? `section-${index}`} className="flex flex-col gap-0.5">
          {section.label ? (
            <h2 className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                  "group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  // A 2px rail on the leading edge rather than a filled pill:
                  // it marks the row without turning it into a button.
                  isActive
                    ? "bg-sidebar-accent/60 text-sidebar-accent-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-r before:bg-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground",
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
