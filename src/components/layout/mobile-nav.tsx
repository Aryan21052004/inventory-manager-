"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { Brand } from "@/components/layout/brand";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { Button } from "@/components/ui/button";
import { DialogOverlay, DialogPortal } from "@/components/ui/dialog";

/**
 * The sidebar as a slide-in drawer, for screens below `lg`.
 *
 * Built on the dialog primitive so it inherits the focus trap and scroll lock —
 * a drawer that leaves the page behind it scrollable is a common and annoying
 * bug, and this avoids re-implementing the fix.
 */
function MobileNav({ appName }: { appName: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [shownFor, setShownFor] = useState(pathname);

  // Close on navigation — otherwise the drawer stays open over the page the
  // user just asked for, including on browser back and forward where no link
  // was clicked. Adjusting state during render rather than in an effect means
  // the closed drawer is part of the same commit as the new route, so it never
  // paints open on the new page first.
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setOpen(false);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden">
          <Menu />
          <span className="sr-only">Open navigation</span>
        </Button>
      </DialogPrimitive.Trigger>

      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar shadow-xl
            data-[state=open]:animate-in data-[state=open]:slide-in-from-left
            data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left"
        >
          <DialogPrimitive.Title className="sr-only">
            Navigation
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Move between sections of {appName}.
          </DialogPrimitive.Description>

          <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-4">
            <Brand appName={appName} />
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-5 scrollbar-thin">
            <SidebarNav onNavigate={() => setOpen(false)} />
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

export { MobileNav };
