import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/password-forms";
import { CsrfInput } from "@/lib/csrf";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm csrf={<CsrfInput />} />;
}
