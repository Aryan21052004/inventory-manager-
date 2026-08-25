import { Show, SignInButton, UserButton } from "@clerk/nextjs";

import { SetupModeMenu } from "@/components/layout/setup-mode-menu";
import { Button } from "@/components/ui/button";

/**
 * Account control in the header.
 *
 * With Clerk configured this is Clerk's own user button, which brings the
 * profile and sign-out flows with it. Without keys the app is running in setup
 * mode, and Clerk's components would throw — so a placeholder menu explains
 * what is missing instead of taking the page down.
 *
 * A server component, deliberately. Clerk Core 3 replaced `<SignedIn>` and
 * `<SignedOut>` with `<Show>`, and the `<Show>` exported from `@clerk/nextjs`
 * is an async server component — it resolves the session on the server rather
 * than shipping both branches and choosing in the browser. That is why this
 * file has no "use client" and why the header takes it as a prop instead of
 * importing it: a client component cannot render an async server one.
 */
function UserMenu({ authEnabled }: { authEnabled: boolean }) {
  if (!authEnabled) {
    return <SetupModeMenu />;
  }

  /*
   * One `<Show>` with a fallback rather than two — a signed-in branch and a
   * signed-out branch that could both miss, or both match, on a session that is
   * neither. `fallback` makes "signed out" mean exactly "not signed in", so the
   * header always has precisely one control in it.
   */
  return (
    <Show
      when="signed-in"
      fallback={
        <SignInButton mode="modal">
          <Button size="sm">Sign in</Button>
        </SignInButton>
      }
    >
      <UserButton
        appearance={{
          elements: {
            avatarBox: "size-8",
            userButtonPopoverCard: "shadow-lg",
          },
        }}
      />
    </Show>
  );
}

export { UserMenu };
