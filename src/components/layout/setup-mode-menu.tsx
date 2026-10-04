"use client";

import Link from "next/link";
import { KeyRound, UserCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The account control shown when Supabase Auth has no keys — development only.
 *
 * Kept separate from `user-menu.tsx` so the two states stay legible on their
 * own terms: this one explains a missing configuration, that one belongs to a
 * real session and can sign out of it.
 */
function SetupModeMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account">
          <UserCircle2 className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Not signed in</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
          Authentication is running in setup mode. Add your Supabase keys to
          <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
            .env.local
          </code>
          to enable sign-in.
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <KeyRound />
            Setup instructions
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { SetupModeMenu };
