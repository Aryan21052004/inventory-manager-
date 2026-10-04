"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, Settings, UserCircle2 } from "lucide-react";

import { SetupModeMenu } from "@/components/layout/setup-mode-menu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

/**
 * Account control in the header.
 *
 * ## The account details come from the server, not from Supabase
 *
 * `name`, `email` and `role` arrive as props, resolved by `getCurrentUser()` from
 * our own `users` table. The browser Supabase client is used for one thing here —
 * ending the session — and never to read application data: `anon` and
 * `authenticated` hold no privilege on any table, so a PostgREST query for a user
 * row would be refused, and it would be the wrong place to ask even if it were
 * not. Prisma on the server is the only path to the database.
 *
 * ## The role shown here decides nothing
 *
 * It is a label, so a user can see which account they are using. Every privileged
 * path re-checks `requireRole()` on the server against the column in the
 * database; hiding a menu item is a courtesy and stops nobody who can open
 * devtools.
 *
 * ## A client component now, where it used to be a server one
 *
 * It had to be a server component for Clerk: `<Show>` resolved the session
 * during the render. Signing out is a browser action, so this is the natural side
 * of the boundary — and the hydration dance that `client-user-button.tsx` existed
 * to perform is gone with it, because nothing here waits for a third-party SDK to
 * load before it can render.
 */

export interface UserMenuAccount {
  name: string;
  email: string;
  role: string;
}

function UserMenu({
  authEnabled,
  account,
}: {
  authEnabled: boolean;
  account: UserMenuAccount | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!authEnabled) {
    return <SetupModeMenu />;
  }

  // Authenticated pages are behind the `(app)` layout's redirect, so in practice
  // this is only reached if the session ended mid-render.
  if (!account) {
    return (
      <Button asChild size="sm">
        <Link href="/sign-in">Sign in</Link>
      </Button>
    );
  }

  function signOut() {
    startTransition(async () => {
      const supabase = createSupabaseBrowserClient();

      /*
       * `scope: "local"` ends this browser's session only. The default, "global",
       * revokes every refresh token the account has — so signing out of a laptop
       * would silently sign the same person out of their phone, which is not what
       * anyone means by clicking this.
       */
      await supabase.auth.signOut({ scope: "local" });

      // `refresh()` first so the server re-renders without the cookie; otherwise
      // the cached render still believes there is a user and the push lands on a
      // page that immediately redirects anyway.
      router.refresh();
      router.push("/sign-in");
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account">
          <UserCircle2 className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate font-medium">{account.name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {account.email}
          </span>
          <span className="pt-1 text-[11px] font-normal uppercase tracking-wide text-muted-foreground">
            {account.role}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut} disabled={pending}>
          <LogOut />
          {pending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { UserMenu };
