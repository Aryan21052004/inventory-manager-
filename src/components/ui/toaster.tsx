"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toast host, mounted once in the root layout.
 *
 * Fire toasts from anywhere with `import { toast } from "sonner"` — there is no
 * provider to thread through. The theme is read from next-themes so toasts
 * follow a manual dark-mode toggle, not just the OS setting.
 */
function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={(resolvedTheme as ToasterProps["theme"]) ?? "system"}
      position="bottom-right"
      closeButton
      richColors
      toastOptions={{
        classNames: {
          toast: "rounded-lg border border-border shadow-lg",
          description: "text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
