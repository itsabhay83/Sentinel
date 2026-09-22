import { OrganizationForm } from "@/components/auth-forms";
import { CsrfInput } from "@/lib/csrf";

export default function OnboardingPage() {
  return <OrganizationForm csrf={<CsrfInput />} />;
}
