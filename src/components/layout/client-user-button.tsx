"use client";

import { useSyncExternalStore } from "react";
import { UserButton } from "@clerk/nextjs";

/**
 * Clerk's account button, rendered only after mount.
 *
 * `UserButton` cannot be server-rendered consistently, and the reason is worth
 * writing down because it looks like a bug in this codebase and is not.
 *
 * Clerk's component renders its host element only once the browser SDK has
 * loaded:
 *
 *     {clerk.loaded && <ClerkHostRenderer ... />}   // renders <div data-clerk-component>
 *
 * On the server `clerk.loaded` is always false, so the server HTML contains no
 * such div. In the browser the SDK is fetched from Clerk's CDN, and when it
 * wins the race against hydration `clerk.loaded` is already true on the very
 * first client render — so React finds a div the server never sent, calls the
 * mismatch, and throws away the server HTML for the entire tree.
 *
 * That cascade is what made this worth fixing rather than suppressing. The
 * re-render reached `next-themes`' inline `<script>` in Providers, which React
 * 19 then complained about too ("scripts inside React components are never
 * executed when rendering on the client") — one root cause, two console errors.
 *
 * Clerk's own `fallback` prop does not solve it: while the SDK is still
 * painting, the loaded client renders the fallback *and* the host div, so the
 * extra div is still there. The only way for both sides to agree is for neither
 * to render the button on the first pass, which is what the mounted flag below
 * does. `suppressHydrationWarning` would not help either — it covers differing
 * text and attributes, not a missing element.
 *
 * The cost is one frame showing a placeholder. It is sized to match the avatar
 * exactly, so nothing moves when the real button arrives.
 */

function AvatarPlaceholder() {
  return (
    <span
      // `size-8` matches the avatarBox below, so the swap costs no layout shift.
      className="block size-8 rounded-full border border-border bg-muted"
      aria-hidden
    />
  );
}

/**
 * Never fires: the value this store reports can only change once, when React
 * stops using the server snapshot. Declared at module scope so its identity is
 * stable and `useSyncExternalStore` does not resubscribe on every render.
 */
const neverChanges = () => () => {};
const onClient = () => true;
const onServer = () => false;

function ClientUserButton() {
  /*
   * `useSyncExternalStore` rather than the usual `useState` + `useEffect`
   * mounted flag. It is the primitive designed for exactly this: React uses
   * `onServer` while rendering on the server *and* while hydrating, then swaps
   * to `onClient` once hydration is done. The two passes that have to agree are
   * guaranteed to, without a state update in an effect.
   */
  const hydrated = useSyncExternalStore(neverChanges, onClient, onServer);

  if (!hydrated) return <AvatarPlaceholder />;

  return (
    <UserButton
      // Clerk's own placeholder, for the gap between this component mounting
      // and the SDK finishing its own render. Hydration is settled by then, so
      // here it is doing the job it is actually for.
      fallback={<AvatarPlaceholder />}
      appearance={{
        elements: {
          avatarBox: "size-8",
          userButtonPopoverCard: "shadow-lg",
        },
      }}
    />
  );
}

export { ClientUserButton };
