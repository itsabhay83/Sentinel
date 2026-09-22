import { SignIn } from "@clerk/nextjs";

// The (auth) layout already centres and brands the page, so this only supplies
// the widget. Catch-all segment is Clerk's requirement: it renders its own
// sub-routes (factor-one, factor-two, SSO callback) underneath this path.
export default function SignInPage() {
  return <SignIn />;
}
