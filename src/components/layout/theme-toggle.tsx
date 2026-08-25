"use client";

import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Light/dark switch.
 *
 * Which icon is correct depends on the active theme, which the server cannot
 * know — so rather than gating on a mounted flag and rendering a placeholder on
 * the first pass, both icons are rendered and CSS hides the wrong one. The
 * `.dark` class is already on <html> before first paint, so the right icon is
 * showing from the very first frame and the markup is identical on both sides
 * of hydration.
 */
function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      title="Toggle theme"
    >
      <Moon className="dark:hidden" aria-hidden />
      <Sun className="hidden dark:block" aria-hidden />
      <span className="sr-only">Toggle between light and dark theme</span>
    </Button>
  );
}

export { ThemeToggle };
