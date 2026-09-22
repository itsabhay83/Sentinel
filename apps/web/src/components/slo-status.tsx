/**
 * Presentation for an error budget.
 *
 * Every branch is on the `ErrorBudget` discriminant rather than on a number,
 * so "no checks landed in this window" cannot render as a confident 0% burn.
 */
import { Badge } from "@/components/ui";
import { burnSeverity, type ErrorBudget } from "@/lib/slo";
import { cn } from "@/lib/utils";

export function BurnBadge({ budget }: { budget: ErrorBudget }) {
  switch (budget.state) {
    case "no_data":
      return <Badge tone="neutral">no data</Badge>;
    case "no_budget":
      return <Badge tone="danger">no budget</Badge>;
    case "measured": {
      const severity = burnSeverity(budget.burnRate);
      return (
        <Badge tone={severity === "critical" ? "danger" : severity === "warn" ? "warn" : "accent"}>
          {budget.burnRate.toFixed(2)}× burn
        </Badge>
      );
    }
  }
}

function fillClass(remainingRatio: number): string {
  if (remainingRatio <= 0) return "bg-down";
  if (remainingRatio < 0.25) return "bg-partial";
  if (remainingRatio < 0.5) return "bg-degraded";
  return "bg-up";
}

/** Remaining budget as a track. An exhausted budget is a full red bar, not an empty one. */
export function BudgetBar({ budget, className }: { budget: ErrorBudget; className?: string }) {
  if (budget.state !== "measured") {
    return <div className={cn("h-1.5 w-full rounded-full bg-line-strong", className)} />;
  }
  const remaining = budget.remainingRatio;
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)}>
      <div
        className={cn("h-full rounded-full transition-all", fillClass(remaining))}
        style={{ width: `${Math.max(remaining * 100, remaining <= 0 ? 100 : 2)}%` }}
      />
    </div>
  );
}

export function budgetTone(budget: ErrorBudget): "default" | "up" | "warn" | "down" {
  switch (budget.state) {
    case "no_data":
      return "default";
    case "no_budget":
      return "down";
    case "measured":
      return burnSeverity(budget.burnRate) === "critical" ? "down" : burnSeverity(budget.burnRate) === "warn" ? "warn" : "up";
  }
}

export function budgetRemainingLabel(budget: ErrorBudget): string {
  switch (budget.state) {
    case "no_data":
      return "—";
    case "no_budget":
      return "0%";
    case "measured":
      return `${(budget.remainingRatio * 100).toFixed(1)}%`;
  }
}

export function budgetSubLabel(budget: ErrorBudget, windowDays: number): string {
  switch (budget.state) {
    case "no_data":
      return `no checks in the last ${windowDays}d`;
    case "no_budget":
      return "a 100% target permits no failures";
    case "measured":
      return budget.remainingRatio > 0 ? `budget left over ${windowDays}d` : `budget exhausted in ${windowDays}d`;
  }
}
