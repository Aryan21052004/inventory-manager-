import { Brand } from "@/components/layout/brand";
import { SidebarNav } from "@/components/layout/sidebar-nav";

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
    </aside>
  );
}

export { Sidebar };
