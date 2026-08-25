import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";

import { AuthSetupNotice } from "@/components/layout/auth-setup-notice";
import { authEnabled } from "@/lib/env";

export const metadata: Metadata = { title: "Create account" };

export default function SignUpPage() {
  if (!authEnabled) {
    return <AuthSetupNotice action="create an account" />;
  }

  return <SignUp />;
}
