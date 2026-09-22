import { Sidebar } from "@/components/shell";
import { logoutAction } from "@/lib/actions/auth";
import { requireOrg } from "@/lib/auth";
import { getOrgSummary } from "@/lib/queries";

/**
 * The protected shell.
 *
 * `requireOrg()` runs before any child page renders, which is what guarantees
 * every query underneath is tenant-scoped — there is no route in this group that
 * can be reached without a resolved organization.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, org } = await requireOrg();
  const summary = await getOrgSummary(org.id);

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <Sidebar org={org} user={user} openIncidents={summary.openIncidents} logout={logoutAction} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
