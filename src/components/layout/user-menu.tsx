"use client";

import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
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
 * Account control in the header.
 *
 * With Clerk configured this is Clerk's own user button, which brings the
 * profile and sign-out flows with it. Without keys the app is running in setup
 * mode, and Clerk's components would throw — so a placeholder menu explains
 * what is missing instead of taking the page down.
 */
function UserMenu({ authEnabled }: { authEnabled: boolean }) {
  if (!authEnabled) {
    return <SetupModeMenu />;
  }

  return (
    <>
      <SignedIn>
        <UserButton
          appearance={{
            elements: {
              avatarBox: "size-8",
              userButtonPopoverCard: "shadow-lg",
            },
          }}
        />
      </SignedIn>
      <SignedOut>
        <SignInButton mode="modal">
          <Button size="sm">Sign in</Button>
        </SignInButton>
      </SignedOut>
    </>
  );
}

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
          Authentication is running in setup mode. Add your Clerk keys to
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

export { UserMenu };
