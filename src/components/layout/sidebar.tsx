import { Brand } from "@/components/layout/brand";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { Badge } from "@/components/ui/badge";

/**
 * Desktop sidebar. Fixed to the viewport and hidden below `lg`, where the
 * mobile drawer takes over — the main column offsets itself with `lg:pl-64` to
 * match this width.
 */
function Sidebar({ appName }: { appName: string }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
      <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-4">
        <Brand appName={appName} />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-5 scrollbar-thin">
        <SidebarNav />
      </div>

      <div className="shrink-0 border-t border-sidebar-border p-3">
        <div className="rounded-lg bg-sidebar-accent/60 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">Foundation build</span>
            <Badge variant="muted" className="text-[10px]">
              v0.1
            </Badge>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            Feature modules are not wired up yet.
          </p>
        </div>
      </div>
    </aside>
  );
}

export { Sidebar };
