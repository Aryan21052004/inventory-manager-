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
 *
 * Dark is the product's default rather than the operating system's preference:
 * this is a control-room tool that people keep open all day, and it is designed
 * dark first. `enableSystem` is off because the toggle only ever writes "light"
 * or "dark" — leaving it on would let a stale stored "system" value quietly
 * override the default. Light mode is still one click away and unchanged.
 */
function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
      <Toaster />
    </ThemeProvider>
  );
}

export { Providers };
