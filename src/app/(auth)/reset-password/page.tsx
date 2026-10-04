import type { Metadata } from "next";

import { AuthSetupNotice } from "@/components/layout/auth-setup-notice";
import { authEnabled } from "@/lib/env";

import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

/**
 * Where a recovery email lands.
 *
 * Deliberately outside the `(app)` group: the person arriving here is not
 * signed in in any ordinary sense, and the layout there would bounce them to
 * /sign-in before they could set the password that would let them sign in.
 */
export default function ResetPasswordPage() {
  if (!authEnabled) {
    return <AuthSetupNotice action="reset a password" />;
  }

  return <ResetPasswordForm />;
}
