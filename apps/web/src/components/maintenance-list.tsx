import { CalendarClock, Globe2 } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { deleteMaintenanceWindowAction } from "@/lib/actions/alerting";
import { setMaintenancePublishedAction, setMaintenanceStatusAction } from "@/lib/actions/maintenance";
import { suppressesAlerts, type MaintenanceStatus, type MaintenanceWindowRow } from "@/lib/maintenance";
import { formatDateTime } from "@/lib/utils";

const STATUS_LABEL: Record<MaintenanceStatus, string> = {
  scheduled: "scheduled",
  in_progress: "in progress",
  completed: "completed",
  cancelled: "cancelled",
};

function statusTone(item: MaintenanceWindowRow): "info" | "warn" | "neutral" {
  switch (item.status) {
    case "scheduled":
      return item.ended ? "neutral" : "info";
    case "in_progress":
      return "warn";
    case "completed":
    case "cancelled":
      return "neutral";
  }
}

export function MaintenanceList({
  windows,
  canManage,
}: {
  windows: MaintenanceWindowRow[];
  canManage: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Maintenance windows</CardTitle>
        <CardDescription>
          Planned work that should not page anyone. Publishing a window also announces it on your status pages.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {windows.length === 0 && <p className="py-6 text-center text-sm text-ink-3">No maintenance scheduled.</p>}
        {windows.map((w) => (
          <div key={w.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
            <Badge tone={statusTone(w)}>
              <CalendarClock className="size-3" />
              {STATUS_LABEL[w.status]}
            </Badge>
            {w.inWindow && suppressesAlerts(w.status) && <Badge tone="warn">suppressing</Badge>}
            {w.published && (
              <Badge tone="accent">
                <Globe2 className="size-3" />
                published
              </Badge>
            )}
            <span className="min-w-0 flex-1 basis-56">
              <span className="block truncate text-sm text-ink">{w.reason || "Maintenance"}</span>
              <span className="block truncate text-xs text-ink-3">
                {formatDateTime(w.startsAt)} → {formatDateTime(w.endsAt)} · {w.monitors.join(", ")}
              </span>
            </span>
            {canManage && <MaintenanceControls item={w} />}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function MaintenanceControls({ item: w }: { item: MaintenanceWindowRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {suppressesAlerts(w.status) && (
        <form action={setMaintenancePublishedAction.bind(null, w.id, !w.published)}>
          <Button type="submit" variant="ghost" size="sm">
            {w.published ? "Unpublish" : "Publish"}
          </Button>
        </form>
      )}
      {w.status === "scheduled" && (
        <form action={setMaintenanceStatusAction.bind(null, w.id, "in_progress")}>
          <Button type="submit" variant="ghost" size="sm">
            Start now
          </Button>
        </form>
      )}
      {w.status === "in_progress" && (
        <form action={setMaintenanceStatusAction.bind(null, w.id, "completed")}>
          <Button type="submit" variant="ghost" size="sm">
            Complete
          </Button>
        </form>
      )}
      {suppressesAlerts(w.status) && (
        <form action={setMaintenanceStatusAction.bind(null, w.id, "cancelled")}>
          <Button type="submit" variant="ghost" size="sm">
            Cancel
          </Button>
        </form>
      )}
      <form action={deleteMaintenanceWindowAction.bind(null, w.id)}>
        <Button type="submit" variant="ghost" size="sm">
          Delete
        </Button>
      </form>
    </span>
  );
}
