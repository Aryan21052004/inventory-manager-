import type { Metadata } from "next";

import { AuthSetupNotice } from "@/components/layout/auth-setup-notice";
import { authEnabled } from "@/lib/env";

import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  if (!authEnabled) {
    return <AuthSetupNotice action="reset a password" />;
  }

  return <ForgotPasswordForm />;
}
