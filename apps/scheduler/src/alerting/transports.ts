import { getServerEnv } from "@sentinel/shared/env";
import { explainFailure, isFailureCode, statusLabel } from "@sentinel/shared";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from "@sentinel/shared/server";

import { logger } from "../logger";
import type { AlertKind } from "./enqueue";

export interface ChannelConfig {
  to?: string;
  url?: string;
  secret?: string;
}

export interface PendingDelivery {
  id: string;
  kind: AlertKind;
  step_index: number;
  attempts: number;
  channel_kind: "email" | "slack" | "discord" | "webhook";
  channel_name: string;
  config: ChannelConfig;
  incident_id: string;
  severity: string;
  /** String, not Date: postgres.js skips its timestamptz parser for scalar
   * subqueries in a RETURNING clause. Read these through `toIso()`. */
  started_at: Date | string;
  resolved_at: Date | string | null;
  primary_failure_code: string | null;
  affected_regions: string[];
  monitor_id: string;
  monitor_name: string;
  monitor_url: string;
}

export const toIso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

function summarize(row: PendingDelivery): { title: string; body: string; color: string } {
  const resolved = row.kind === "resolve";
  const label = statusLabel(
    row.severity === "down" ? "DOWN" : row.severity === "partial" ? "PARTIAL_OUTAGE" : "DEGRADED",
  );
  const explanation =
    row.primary_failure_code && isFailureCode(row.primary_failure_code)
      ? explainFailure(row.primary_failure_code)
      : null;

  const title = resolved ? `Resolved: ${row.monitor_name}` : `${label}: ${row.monitor_name}`;

  const lines = [
    `Monitor: ${row.monitor_name}`,
    `Target: ${row.monitor_url}`,
    resolved
      ? `Recovered at ${toIso(row.resolved_at) ?? new Date().toISOString()}`
      : `Started at ${toIso(row.started_at)}`,
  ];
  if (!resolved) {
    lines.push(`Failing regions: ${row.affected_regions.join(", ") || "n/a"}`);
    if (explanation) {
      lines.push(`Cause: ${explanation.label} — ${explanation.explanation}`);
      lines.push(`Next step: ${explanation.suggestedAction}`);
    }
  }
  lines.push(`${getServerEnv().NEXT_PUBLIC_APP_URL}/monitors/${row.monitor_id}`);

  return {
    title,
    body: lines.join("\n"),
    color: resolved ? "#10b981" : row.severity === "down" ? "#ef4444" : "#f59e0b",
  };
}

export async function postEmail(to: string, title: string, body: string): Promise<number> {
  const env = getServerEnv();
  if (!env.RESEND_API_KEY) {
    logger.info({ to, title, body }, "email alert (stdout transport)");
    return 200;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: env.ALERT_EMAIL_FROM, to: [to], subject: title, text: body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`resend ${response.status}: ${await response.text()}`);
  }
  return response.status;
}

async function postJson(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.status;
}

export async function deliver(row: PendingDelivery): Promise<number> {
  const { title, body, color } = summarize(row);
  switch (row.channel_kind) {
    case "email": {
      const to = row.config.to;
      if (!to) throw new Error("email channel has no `to` address");
      return postEmail(to, title, body);
    }
    case "slack": {
      if (!row.config.url) throw new Error("slack channel has no webhook url");
      return postJson(row.config.url, { text: title, attachments: [{ color, text: body }] });
    }
    case "discord": {
      if (!row.config.url) throw new Error("discord channel has no webhook url");
      return postJson(row.config.url, {
        embeds: [{ title, description: body, color: Number.parseInt(color.slice(1), 16) }],
      });
    }
    case "webhook": {
      if (!row.config.url) throw new Error("webhook channel has no url");
      const payload = JSON.stringify({
        event: row.kind === "resolve" ? "incident.resolved" : "incident.opened",
        incidentId: row.incident_id,
        monitor: { id: row.monitor_id, name: row.monitor_name, url: row.monitor_url },
        severity: row.severity,
        primaryFailureCode: row.primary_failure_code,
        affectedRegions: row.affected_regions,
        startedAt: toIso(row.started_at),
        resolvedAt: toIso(row.resolved_at),
      });
      const headers: Record<string, string> = {};
      if (row.config.secret) {
        const timestamp = Math.floor(Date.now() / 1000);
        headers[TIMESTAMP_HEADER] = String(timestamp);
        headers[SIGNATURE_HEADER] = signWebhook(payload, row.config.secret, timestamp);
      }
      return postJson(row.config.url, payload, headers);
    }
    default: {
      const exhaustive: never = row.channel_kind;
      throw new Error(`unsupported channel ${String(exhaustive)}`);
    }
  }
}
