import type { Metadata } from "next";

import { AuthSetupNotice } from "@/components/layout/auth-setup-notice";
import { authEnabled } from "@/lib/env";

import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create an account" };

/** A plain route — see the note in ../sign-in/page.tsx about the catch-all. */
export default function SignUpPage() {
  if (!authEnabled) {
    return <AuthSetupNotice action="create an account" />;
  }

  return <SignUpForm />;
}
