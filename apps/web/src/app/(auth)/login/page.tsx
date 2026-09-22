import { LoginForm } from "@/components/auth-forms";
import { CsrfInput } from "@/lib/csrf";

export default function LoginPage() {
  return <LoginForm csrf={<CsrfInput />} />;
}
