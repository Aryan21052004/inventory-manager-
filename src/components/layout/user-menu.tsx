import { Show, SignInButton } from "@clerk/nextjs";

import { ClientUserButton } from "@/components/layout/client-user-button";
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
 *
 * The account button inside the signed-in branch is the one piece that cannot
 * be server-rendered; it is isolated in its own client component so the rest of
 * this stays on the server.
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
      {/*
        Clerk's UserButton is deliberately not server-rendered — it only emits
        its host element once the browser SDK has loaded, which the server can
        never be. See ClientUserButton for the full explanation.

        The signed-out branch needs no such treatment: SignInButton renders its
        child regardless of load state, so both sides agree.
      */}
      <ClientUserButton />
    </Show>
  );
}

export { UserMenu };
