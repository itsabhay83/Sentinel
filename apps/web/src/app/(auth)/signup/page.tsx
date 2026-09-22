import { SignupForm } from "@/components/auth-forms";
import { CsrfInput } from "@/lib/csrf";

export default function SignupPage() {
  return <SignupForm csrf={<CsrfInput />} />;
}
