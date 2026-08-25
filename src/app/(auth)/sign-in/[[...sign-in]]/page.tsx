import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";

import { AuthSetupNotice } from "@/components/layout/auth-setup-notice";
import { authEnabled } from "@/lib/env";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Optional catch-all so Clerk can own its own sub-routes (verification, factor
 * two, and so on) under this single page.
 */
export default function SignInPage() {
  if (!authEnabled) {
    return <AuthSetupNotice action="sign in" />;
  }

  return <SignIn />;
}
