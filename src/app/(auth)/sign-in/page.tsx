import type { Metadata } from "next";

import { AuthSetupNotice } from "@/components/layout/auth-setup-notice";
import { authEnabled } from "@/lib/env";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

/**
 * A plain route, no longer an optional catch-all.
 *
 * The `[[...sign-in]]` segment existed so Clerk could own its own sub-routes
 * under this path — verification, second factor, and so on. Supabase handles
 * those by emailing a link back to a route of ours, so the catch-all would now
 * only mean that `/sign-in/anything` quietly renders the sign-in page.
 */
export default function SignInPage() {
  if (!authEnabled) {
    return <AuthSetupNotice action="sign in" />;
  }

  return <SignInForm />;
}
