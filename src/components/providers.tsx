"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "next-themes";

import { Toaster } from "@/components/ui/toaster";

/**
 * Client-side providers, mounted once at the root.
 *
 * `disableTransitionOnChange` suppresses the colour transitions while the theme
 * swaps — without it every element animates at once and the switch looks like a
 * smear rather than a change.
 */
function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
      <Toaster />
    </ThemeProvider>
  );
}

export { Providers };
